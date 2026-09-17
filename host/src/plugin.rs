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
    /// Frontend UI contributions. Optional — a backend-only plugin omits it.
    #[serde(default)]
    pub ui: Option<UiDecl>,
}

/// One plugin's *adjustment* to UI that other plugins already contribute.
///
/// This is the capability this host has and dsh-web does not: a plugin loaded
/// **later** can reshape existing UI without touching the contributing plugin's
/// code. The frontend applies these at **resolution** time (when a slot's mount
/// list is computed), never by mutating another plugin's DOM — so adjustments
/// compose, stay reversible, and follow the same order-independence rules as
/// claims.
///
/// `slot` is a glob: `settings.tabs` matches that slot; `*` matches every slot.
/// `from` is a glob over the contributing plugin's id, so an adjustment can
/// target "everything plugin `noisy` contributes anywhere".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiAdjust {
    /// Which contributions this applies to. Supports a trailing `*` wildcard.
    #[serde(default = "adjust_target_default")]
    pub slot: String,
    /// Which plugin's contribution to affect (the owner id). `None` = any.
    /// Supports a trailing `*` wildcard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// What to do.
    pub action: AdjustAction,
    /// For `priority`: the new priority (lower renders first).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<i32>,
    /// For `priority`: new position for the target's own priority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<i32>,
    /// For `replace`: the component name the *adjusting* plugin registered, to
    /// render in place of the original. Ignored by other actions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
}

fn adjust_target_default() -> String {
    "*".to_string()
}

/// The adjustments a plugin can apply to existing contributions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdjustAction {
    /// Remove the contribution from the rendered list (the plugin stays loaded;
    /// an `unhide` by another plugin can bring it back).
    Hide,
    /// Re-show a contribution hidden by `hide`.
    Unhide,
    /// Replace the contribution's component with another name the *adjusting*
    /// plugin registered. Falls back to the original when it is not registered.
    Replace,
    /// Move the contribution in render order: `to` is an absolute priority,
    /// `by` a delta on its own.
    Priority,
}

/// A plugin's frontend contribution.
///
/// The **slots** pair mirrors `provides`/`injects`, but for the frontend's
/// layout: a plugin may open its own named slot for others to fill
/// (`provides`), and/or declare that its UI wants to appear inside a slot
/// someone else supplies (`injects`). Resolution is order-independent and
/// reactive: a contribution whose slot does not exist yet is *pending*, and a
/// slot that disappears hides its contributors until it returns.
///
/// The **assets** are opaque strings — the frontend decides how to run them.
///
/// The **adjusts** let a later-loaded plugin reshape UI another plugin already
/// contributes — see [`UiAdjust`].
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UiDecl {
    /// Slots this plugin **opens** for others to contribute into.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provides: Vec<SlotDecl>,
    /// Slots this plugin's UI wants to be **rendered inside**.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub injects: Vec<SlotInject>,
    /// `{ "entry.js": "<source>", "style.css": "<source>" }`. The frontend
    /// executes `entry.js`; the plugin registers its components from there.
    /// Kept as strings so the ABI stays language- and scheme-agnostic.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub assets: std::collections::BTreeMap<String, String>,
    /// Extra top-level windows this plugin wants to open.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<WindowDecl>,
    /// Adjustments this plugin applies to *other* plugins' contributions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub adjusts: Vec<UiAdjust>,
}

/// A top-level window a plugin offers.
///
/// The window loads the *app* (not a plugin-supplied page) and renders one of
/// the plugin's registered `component`s full-window, with no app chrome. This
/// keeps the plugin's UI code identical to its in-slot components — only the
/// mount point differs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowDecl {
    /// Stable identifier, unique within the plugin. The real window label is
    /// derived from it (prefixed with the slot) so two plugins cannot collide.
    pub name: String,
    /// Which registered component to render in the window.
    pub component: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    /// When to open it.
    #[serde(default)]
    pub open: WindowOpen,
    /// How the window is populated.
    #[serde(default)]
    pub content: WindowContent,
    /// The page source, when `content == "html"`. A full HTML fragment
    /// (scripts and styles allowed). Ignored for `content == "app"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
}

/// What a window loads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowContent {
    /// The app itself, rendering the declared `component` full-window. The
    /// plugin's UI code is identical to its in-slot components.
    #[default]
    App,
    /// A **fully self-contained page** the plugin supplies: the host loads an
    /// empty document and injects the plugin's `html` (which may include its own
    /// `<style>` and `<script>`). Maximum freedom, no app shell, no `studio` API
    /// unless the plugin opts into it.
    Html,
}

/// How a declared window comes into existence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowOpen {
    /// Never opened by the host; the plugin's UI opens it on demand (e.g. a
    /// button in one of its panels).
    #[default]
    Manual,
    /// Opened by the host as soon as the plugin becomes active, and closed when
    /// it stops.
    Auto,
}

/// A slot a plugin opens for others.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotDecl {
    /// Globally unique slot name, e.g. `llm-ui.config`. Namespacing by plugin
    /// is convention, not enforcement.
    pub name: String,
    /// Human-readable purpose, shown in the UI's slot inspector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A declaration that this plugin's UI belongs inside another slot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotInject {
    /// The slot to render into (may be opened by another plugin).
    pub slot: String,
    /// Lower renders first. Lets a plugin order itself among contributors.
    #[serde(default)]
    pub priority: i32,
    /// A key into `assets` naming which registered component to mount. The
    /// frontend's `register()` call maps names to components.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
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
                ui: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// An `adjusts` block is what lets a plugin reshape UI it does not own, so
    /// parsing must be exact — a typo in `action` must be rejected, not
    /// silently ignored, or a plugin would appear to apply no adjustment.
    #[test]
    fn parses_an_adjusts_block() {
        let json = r#"{
            "name": "curator",
            "tools": [],
            "ui": {
                "adjusts": [
                    {"slot": "settings.*", "from": "noisy-*", "action": "hide"},
                    {"slot": "*", "action": "priority", "from": "llm-ui", "to": -5},
                    {"slot": "dashboard.cards", "action": "replace", "component": "Mine"}
                ]
            }
        }"#;
        let decl: PluginDecl = serde_json::from_str(json).unwrap();
        let ui = decl.ui.expect("ui block");
        assert_eq!(ui.adjusts.len(), 3);

        assert_eq!(ui.adjusts[0].action, AdjustAction::Hide);
        assert_eq!(ui.adjusts[0].slot, "settings.*");
        assert_eq!(ui.adjusts[0].from.as_deref(), Some("noisy-*"));

        assert_eq!(ui.adjusts[1].action, AdjustAction::Priority);
        assert_eq!(ui.adjusts[1].to, Some(-5));
        assert_eq!(ui.adjusts[1].by, None);

        assert_eq!(ui.adjusts[2].action, AdjustAction::Replace);
        assert_eq!(ui.adjusts[2].component.as_deref(), Some("Mine"));
    }

    /// `slot` defaults to "*" so `{"action":"hide"}` means "hide everything",
    /// which is the useful shorthand for a plugin that wants to prune the UI.
    #[test]
    fn an_adjusts_slot_defaults_to_match_all() {
        let json = r#"{"name":"c","tools":[],"ui":{"adjusts":[{"action":"hide"}]}}"#;
        let decl: PluginDecl = serde_json::from_str(json).unwrap();
        assert_eq!(decl.ui.unwrap().adjusts[0].slot, "*");
    }

    /// The action vocabulary is closed: a typo must fail loudly.
    #[test]
    fn an_unknown_adjust_action_is_rejected() {
        let json = r#"{"name":"c","tools":[],"ui":{"adjusts":[{"action":"conceal"}]}}"#;
        let err = serde_json::from_str::<PluginDecl>(json).unwrap_err();
        assert!(
            err.to_string().contains("conceal") || err.to_string().contains("unknown variant"),
            "expected a variant error, got: {err}"
        );
    }

    /// Adjustments are optional; a plugin without a `ui` block still parses.
    #[test]
    fn a_plugin_without_ui_blocks_still_parses() {
        let decl: PluginDecl = serde_json::from_str(r#"{"name":"p","tools":[]}"#).unwrap();
        assert!(decl.ui.is_none());
    }
}
