//! `Plugin` — a loaded WASM instance with a dsh/cordis-style lifecycle.
//!
//! The host is the framework; the plugin only computes. Loading registers
//! effects (here: tool registrations) that unwind on unload.
//!
//! Because a WASM `Instance` is an ordinary Rust value, dropping it **really**
//! releases code and linear memory — the thing `dlopen` cannot do.

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use wasmtime::{Engine, Instance, Memory, Store, TypedFunc};

use crate::state::HostState;

/// Lifecycle states, mirroring cordis `FiberState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginState {
    Pending,
    Init,
    Active,
    ShuttingDown,
    Disposed,
    Failed,
}

/// One tool declared by a plugin's `describe` output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDecl {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub parameters: serde_json::Value,
    /// The `op` string to pass to `plugin_invoke`.
    pub exec: String,
}

/// The full declaration a plugin returns from `plugin_describe`.
///
/// Beyond `tools` (leaf handlers), a plugin may **intervene in the flow** by
/// subscribing to events, and may **participate in the service graph** by
/// declaring what it injects and provides. This is the dsh model: the plugin is
/// not just a callable leaf, it is a participant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginDecl {
    pub name: String,
    #[serde(default = "one")]
    pub abi: i32,
    #[serde(default)]
    pub tools: Vec<ToolDecl>,
    /// Event subscriptions. Each becomes a hook the host calls when the flow
    /// reaches that point. See [`HookDecl`].
    #[serde(default)]
    pub hooks: Vec<HookDecl>,
    /// Service names this plugin *needs*. The plugin is only activated once all
    /// of them are provided by some loaded plugin (dsh `inject`).
    #[serde(default)]
    pub injects: Vec<String>,
    /// Service names this plugin *provides* to others (dsh `ctx.provide`).
    #[serde(default)]
    pub provides: Vec<String>,
}

/// How a hook participates when the flow reaches its event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookMode {
    /// Fire-and-forget: the return value is ignored. For logging, metrics,
    /// side effects. Cannot change the flow.
    Observe,
    /// The plugin may **veto or rewrite** the payload. Its decision gates the
    /// flow (dsh "waterfall"): a veto stops the step, a rewrite replaces the
    /// value passed on.
    Waterfall,
}

/// One event subscription.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookDecl {
    /// The event to subscribe to, e.g. `"tools/pre-execute"`. See
    /// [`crate::hooks::EVENTS`] for the vocabulary.
    pub on: String,
    /// The `op` string passed to `plugin_invoke` when the event fires.
    pub exec: String,
    #[serde(default = "default_hook_mode")]
    pub mode: HookMode,
    /// Lower runs first. Lets a plugin order itself relative to others.
    #[serde(default)]
    pub priority: i32,
}

fn default_hook_mode() -> HookMode {
    HookMode::Waterfall
}

fn one() -> i32 {
    1
}

/// Host-visible result of a `plugin_invoke` call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum InvokeResult {
    Success {
        #[serde(default)]
        content: String,
        #[serde(default)]
        value: serde_json::Value,
    },
    Error {
        message: String,
        #[serde(default)]
        code: String,
    },
}

/// A loaded plugin instance.
pub struct Plugin {
    pub name: String,
    pub path: String,
    pub state: PluginState,
    pub decl: PluginDecl,
    pub logs: std::sync::Arc<crate::state::LogSink>,
    store: Store<HostState>,
    instance: Instance,
    memory: Memory,
    f_alloc: TypedFunc<i32, i32>,
    f_free: TypedFunc<(i32, i32), ()>,
    f_describe: TypedFunc<(i32, i32), i64>,
    f_invoke: TypedFunc<(i32, i32, i32, i32, i32, i32), i64>,
    f_shutdown: Option<TypedFunc<(), ()>>,
    /// Optional `plugin_configure(out, cap) -> rc` — called once at load with
    /// the entry's config; the plugin reads it via `host.get_config`.
    f_configure: Option<TypedFunc<(i32, i32), i32>>,
    /// Optional `plugin_on_config() -> rc` — called on a live config push.
    f_on_config: Option<TypedFunc<(), i32>>,
    /// Shared handle to this plugin's live config, so `set_config` can update it
    /// even while the guest holds a `Caller` into the same store.
    config: std::sync::Arc<std::sync::Mutex<serde_json::Value>>,
    config_version: std::sync::Arc<std::sync::atomic::AtomicI64>,
}

/// Scratch buffer size for crossing the ABI boundary. Grows if a plugin
/// signals `-(needed)` for a larger result.
const INITIAL_BUF: usize = 64 * 1024;
const MAX_BUF: usize = 16 * 1024 * 1024;

impl Plugin {
    /// Load, init and describe a plugin. Registers nothing yet — the caller
    /// decides what to do with `decl.tools`. `config` is the entry's config
    /// object (JSON `null` when unset); it is pushed into the plugin's
    /// `HostState` and, if the plugin exports `plugin_configure`, that hook runs
    /// once so the plugin can read it through `host.get_config`.
    pub fn load(
        engine: &Engine,
        path: &Path,
        runtime: &crate::runtime::Runtime,
        slot: &str,
        config: serde_json::Value,
        log: std::sync::Arc<crate::state::LogSink>,
        services: Option<std::sync::Arc<crate::service::Shared>>,
    ) -> Result<Plugin> {
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "plugin".to_string());

        let module = runtime.compile(engine, path)?;
        let state = HostState::new(slot, &name, config, log.clone(), services);
        let config_handle = state.config.clone();
        let version_handle = state.config_version.clone();
        let mut store = Store::new(engine, state);

        // Give each instance a fuel/limit budget would go here (see docs).
        let instance = runtime.instantiate(&mut store, &module)?;

        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| anyhow!("plugin `{name}` does not export `memory`"))?;

        // ABI version gate.
        let abi: TypedFunc<(), i32> = get(instance, &mut store, &name, "plugin_abi_version")?;
        let v = abi.call(&mut store, ())?;
        if v != 1 {
            bail!("plugin `{name}` speaks ABI v{v}, host expects v1");
        }

        let f_alloc: TypedFunc<i32, i32> = get(instance, &mut store, &name, "plugin_alloc")?;
        let f_free: TypedFunc<(i32, i32), ()> = get(instance, &mut store, &name, "plugin_free")?;
        let f_describe: TypedFunc<(i32, i32), i64> =
            get(instance, &mut store, &name, "plugin_describe")?;
        let f_invoke: TypedFunc<(i32, i32, i32, i32, i32, i32), i64> =
            get(instance, &mut store, &name, "plugin_invoke")?;
        let f_shutdown: Option<TypedFunc<(), ()>> =
            instance.get_typed_func(&mut store, "plugin_shutdown").ok();
        // Config hooks are optional — older plugins simply don't export them.
        let f_configure: Option<TypedFunc<(i32, i32), i32>> =
            instance.get_typed_func(&mut store, "plugin_configure").ok();
        let f_on_config: Option<TypedFunc<(), i32>> =
            instance.get_typed_func(&mut store, "plugin_on_config").ok();

        let mut plugin = Plugin {
            name: name.clone(),
            path: path.display().to_string(),
            state: PluginState::Pending,
            decl: PluginDecl {
                name: name.clone(),
                abi: 1,
                tools: vec![],
                hooks: vec![],
                injects: vec![],
                provides: vec![],
            },
            logs: log,
            store,
            instance,
            memory,
            f_alloc,
            f_free,
            f_describe,
            f_invoke,
            f_shutdown,
            f_configure,
            f_on_config,
            config: config_handle,
            config_version: version_handle,
        };

        // Init.
        plugin.state = PluginState::Init;
        let init: TypedFunc<(), i32> = get(plugin.instance, &mut plugin.store, &plugin.name, "plugin_init")?;
        let rc = init.call(&mut plugin.store, ())?;
        if rc != 0 {
            plugin.state = PluginState::Failed;
            bail!("plugin `{name}` init failed with code {rc}");
        }

        // Configure (optional): hand the config over once so the plugin can read
        // it now via `host.get_config` and cache whatever it needs.
        if plugin.f_configure.is_some() {
            let rc = plugin.call_configure()?;
            if rc != 0 {
                plugin.state = PluginState::Failed;
                bail!("plugin `{name}` plugin_configure failed with code {rc}");
            }
        }

        // Describe.
        let json = plugin.call_describe()?;
        let decl: PluginDecl = serde_json::from_str(&json).map_err(|e| {
            anyhow!("plugin `{name}` returned invalid declaration JSON ({e}): {json}")
        })?;
        if decl.abi != 1 {
            plugin.state = PluginState::Failed;
            bail!("plugin `{name}` declares abi {}, expected 1", decl.abi);
        }
        plugin.decl = decl;
        plugin.state = PluginState::Active;
        Ok(plugin)
    }

    /// Current config value (JSON `null` if unset).
    pub fn config(&self) -> serde_json::Value {
        self.config.lock().unwrap().clone()
    }

    /// Push a new config to a LIVE plugin without reloading it.
    ///
    /// The value is written into the shared `HostState`, the version is bumped,
    /// and — if the plugin exports `plugin_on_config` — that hook is invoked so
    /// the plugin can react immediately. Returns `false` if the plugin has no
    /// `plugin_on_config` hook (the config is still updated and readable via
    /// `host.get_config`).
    pub fn set_config(&mut self, config: serde_json::Value) -> Result<bool> {
        // Update shared state first: the guest may read it during the hook.
        *self.config.lock().unwrap() = config;
        self.config_version
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        if let Some(f) = &self.f_on_config {
            let rc = f.call(&mut self.store, ())?;
            if rc != 0 {
                bail!("plugin `{}` plugin_on_config failed with code {rc}", self.name);
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn has_config_hook(&self) -> bool {
        self.f_on_config.is_some()
    }

    pub fn tools(&self) -> &[ToolDecl] {
        &self.decl.tools
    }

    pub fn is_active(&self) -> bool {
        self.state == PluginState::Active
    }

    /// Invoke `op` with JSON `args`, returning the parsed result.
    pub fn invoke(&mut self, op: &str, args: &serde_json::Value) -> Result<InvokeResult> {
        if self.state != PluginState::Active {
            bail!("plugin `{}` is not active ({:?})", self.name, self.state);
        }
        let args_json = serde_json::to_string(args)?;
        let raw = self.call_op(op, &args_json)?;
        let res: InvokeResult = serde_json::from_str(&raw)
            .map_err(|e| anyhow!("plugin `{}` returned bad JSON ({e}): {raw}", self.name))?;
        Ok(res)
    }

    /// Invoke `op` and return its **raw** JSON reply, without the tool-result
    /// shape check. Used for hooks, whose replies are decisions
    /// (`continue`/`rewrite`/`veto`), not tool results.
    pub fn invoke_raw(&mut self, op: &str, args: &serde_json::Value) -> Result<serde_json::Value> {
        if self.state != PluginState::Active {
            bail!("plugin `{}` is not active ({:?})", self.name, self.state);
        }
        let args_json = serde_json::to_string(args)?;
        let raw = self.call_op(op, &args_json)?;
        serde_json::from_str(&raw)
            .map_err(|e| anyhow!("plugin `{}` returned bad JSON ({e}): {raw}", self.name))
    }

    /// Unload: call `plugin_shutdown`, then the caller drops the `Plugin`,
    /// which releases code + linear memory.
    pub fn shutdown(&mut self) {
        if matches!(self.state, PluginState::Disposed | PluginState::Failed) {
            return;
        }
        self.state = PluginState::ShuttingDown;
        if let Some(f) = &self.f_shutdown {
            let _ = f.call(&mut self.store, ());
        }
        self.state = PluginState::Disposed;
    }

    // ---- internals: ABI plumbing ----

    fn call_describe(&mut self) -> Result<String> {
        self.with_growable_buf(|plugin, ptr, cap| {
            let n = plugin.f_describe.call(&mut plugin.store, (ptr, cap))?;
            Ok(n)
        })
    }

    /// Call the optional `plugin_configure(out, cap) -> i32` hook. The plugin
    /// reads its config via `host.get_config`; `out`/`cap` are scratch space it
    /// may use to echo back a summary (ignored by the host here).
    fn call_configure(&mut self) -> Result<i32> {
        let cap = 64 * 1024;
        let ptr = self.guest_alloc(cap)?;
        // Split borrows: `f` borrows `f_configure`, `store` is disjoint.
        let Some(f) = self.f_configure.as_ref() else {
            let _ = self.f_free.call(&mut self.store, (ptr, cap));
            anyhow::bail!("plugin `{}` has no plugin_configure", self.name);
        };
        let rc = f.call(&mut self.store, (ptr, cap as i32))?;
        let _ = self.f_free.call(&mut self.store, (ptr, cap));
        Ok(rc)
    }

    fn call_op(&mut self, op: &str, args_json: &str) -> Result<String> {
        // Allocate guest memory for the op + args, per call.
        let op_bytes = op.as_bytes();
        let args_bytes = args_json.as_bytes();
        let op_ptr = self.guest_alloc(op_bytes.len() as i32)?;
        let args_ptr = self.guest_alloc(args_bytes.len() as i32)?;
        self.memory.write(&mut self.store, op_ptr as usize, op_bytes)?;
        self.memory
            .write(&mut self.store, args_ptr as usize, args_bytes)?;

        let out = self.with_growable_buf(|plugin, ptr, cap| {
            let n = plugin.f_invoke.call(
                &mut plugin.store,
                (
                    op_ptr,
                    op_bytes.len() as i32,
                    args_ptr,
                    args_bytes.len() as i32,
                    ptr,
                    cap,
                ),
            )?;
            Ok(n)
        });

        // Best-effort free of the input buffers.
        let _ = self.f_free.call(&mut self.store, (op_ptr, op_bytes.len() as i32));
        let _ = self.f_free.call(&mut self.store, (args_ptr, args_bytes.len() as i32));

        out
    }

    fn guest_alloc(&mut self, size: i32) -> Result<i32> {
        let p = self.f_alloc.call(&mut self.store, size)?;
        if p == 0 {
            bail!("plugin `{}` plugin_alloc({size}) failed", self.name);
        }
        Ok(p)
    }

    /// Drive a `(out, cap) -> i64` guest call, growing the buffer if the guest
    /// answers `-(needed)`.
    fn with_growable_buf<F>(&mut self, mut call: F) -> Result<String>
    where
        F: FnMut(&mut Plugin, i32, i32) -> Result<i64>,
    {
        let mut cap = INITIAL_BUF;
        loop {
            let out_ptr = self.guest_alloc(cap as i32)?;
            let n = call(self, out_ptr, cap as i32)?;
            if n >= 0 {
                let len = n as usize;
                let mut buf = vec![0u8; len];
                self.memory.read(&self.store, out_ptr as usize, &mut buf)?;
                let _ = self.f_free.call(&mut self.store, (out_ptr, cap as i32));
                return String::from_utf8(buf).map_err(|e| anyhow!("plugin returned non-UTF8: {e}"));
            }
            // n < 0 → guest needs |n| bytes.
            let needed = (-n) as usize;
            let _ = self.f_free.call(&mut self.store, (out_ptr, cap as i32));
            if needed > MAX_BUF {
                bail!("plugin `{}` requested {needed} bytes (> cap {MAX_BUF})", self.name);
            }
            cap = needed.max(cap * 2);
        }
    }
}

impl Drop for Plugin {
    fn drop(&mut self) {
        // Instance and Store drop here — WASM memory + code released.
        self.state = PluginState::Disposed;
    }
}

/// Fetch a typed export, mapping a missing export to a good error message.
fn get<T, P>(
    instance: Instance,
    store: &mut Store<HostState>,
    plugin: &str,
    name: &str,
) -> Result<TypedFunc<T, P>>
where
    T: wasmtime::WasmParams,
    P: wasmtime::WasmResults,
{
    instance
        .get_typed_func::<T, P>(store, name)
        .map_err(|e| anyhow!("plugin `{plugin}` is missing export `{name}`: {e}"))
}
