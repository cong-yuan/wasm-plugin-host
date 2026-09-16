//! [`WasmHost`] — a thread-safe handle around the WASM plugin registry.
//!
//! The underlying [`Registry`] needs `&mut self` for every state transition, so
//! the host owns it behind a `Mutex` and shares it by `Arc`. `Registry` is
//! `Send` (its WASM `Store`s are moved, never aliased), and `Mutex<T>: Sync`
//! when `T: Send`, so `Arc<Mutex<Registry>>` is safely shareable across the
//! cordis fibers, the tool callbacks, and the flow listeners.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context as _, Result};
use serde_json::Value;

use wasm_plugin_host::{
    LoadedReport, LogHook, LogRecord, PluginState, Registry, ReloadReport, Runtime,
};

/// Options for building a [`WasmHost`].
#[derive(Default)]
pub struct HostOptions {
    /// Bound on the per-plugin log ring buffer (default 1000).
    pub log_capacity: Option<usize>,
    /// Mirror guest stderr to the host's stderr.
    pub echo_stderr: bool,
    /// A callback invoked for every guest log line. Wire this to a cordis
    /// logger or a UI channel.
    pub log_hook: Option<LogHook>,
    /// Enable the on-disk `.cwasm` compile cache at this directory. `None`
    /// keeps compilation in-process only.
    pub cache_dir: Option<PathBuf>,
}

impl std::fmt::Debug for HostOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostOptions")
            .field("log_capacity", &self.log_capacity)
            .field("echo_stderr", &self.echo_stderr)
            .field("log_hook", &self.log_hook.is_some())
            .finish()
    }
}

/// A tool as the bridge sees it (flattened from the registry's `RegisteredTool`
/// so callers do not need a live borrow of the registry).
#[derive(Debug, Clone)]
pub struct WasmToolInfo {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub slot: String,
    pub plugin: String,
}

/// A cheap-clone, thread-safe handle over a running WASM plugin registry.
#[derive(Clone)]
pub struct WasmHost {
    registry: Arc<Mutex<Registry>>,
}

impl WasmHost {
    /// Build a host with default options.
    pub fn new() -> Result<Self> {
        Self::with_options(HostOptions::default())
    }

    /// Build a host with explicit options.
    pub fn with_options(opts: HostOptions) -> Result<Self> {
        let runtime = match &opts.cache_dir {
            Some(dir) => Runtime::new_cached(dir).context("building the cached wasmtime runtime")?,
            None => Runtime::new().context("building the wasmtime runtime")?,
        };
        let registry = Registry::with_logging(
            runtime,
            opts.log_capacity.unwrap_or(1000),
            opts.echo_stderr,
            opts.log_hook,
        );
        Ok(Self {
            registry: Arc::new(Mutex::new(registry)),
        })
    }

    /// Wrap an existing registry (e.g. one the caller already configured).
    pub fn from_registry(registry: Registry) -> Self {
        Self {
            registry: Arc::new(Mutex::new(registry)),
        }
    }

    /// The shared registry handle, for callers that need the raw API (e.g. to
    /// drive a `Supervisor`, or to reach hooks/services directly).
    pub fn registry(&self) -> Arc<Mutex<Registry>> {
        self.registry.clone()
    }

    /// Load a plugin into `slot`. `config` is the JSON injected into the guest.
    pub fn load(&self, slot: &str, path: impl AsRef<Path>, config: Value) -> Result<LoadedReport> {
        self.registry
            .lock()
            .expect("registry mutex poisoned")
            .load(slot, path.as_ref(), config)
    }

    /// Unload a slot, returning the tool names that were removed.
    pub fn unload(&self, slot: &str) -> Result<Vec<String>> {
        self.registry
            .lock()
            .expect("registry mutex poisoned")
            .unload(slot)
    }

    /// Atomically swap a slot's code (stage-then-commit).
    pub fn reload(
        &self,
        slot: &str,
        path: impl AsRef<Path>,
        config: Option<Value>,
    ) -> Result<ReloadReport> {
        self.registry
            .lock()
            .expect("registry mutex poisoned")
            .reload(slot, path.as_ref(), config)
    }

    /// Push a new config to a running slot (live, no restart).
    pub fn apply_config(&self, slot: &str, config: Value) -> Result<bool> {
        self.registry
            .lock()
            .expect("registry mutex poisoned")
            .apply_config(slot, config)
    }

    /// Call a tool by name; the guest's raw JSON reply is returned.
    pub fn call_tool(&self, tool: &str, args: &Value) -> Result<Value> {
        self.registry
            .lock()
            .expect("registry mutex poisoned")
            .call_tool(tool, args)
    }

    /// Every currently registered tool, flattened.
    pub fn list_tools(&self) -> Vec<WasmToolInfo> {
        let reg = self.registry.lock().expect("registry mutex poisoned");
        reg.list_tools()
            .into_iter()
            .map(|t| WasmToolInfo {
                name: t.name.clone(),
                description: t.description.clone(),
                parameters: t.parameters.clone(),
                slot: t.slot.clone(),
                plugin: t.plugin.clone(),
            })
            .collect()
    }

    /// `(slot, plugin, state, tool_count, active)` for every loaded slot.
    pub fn list_plugins(&self) -> Vec<(String, String, PluginState, usize, bool)> {
        self.registry
            .lock()
            .expect("registry mutex poisoned")
            .list_plugins()
    }

    pub fn is_loaded(&self, slot: &str) -> bool {
        self.registry
            .lock()
            .expect("registry mutex poisoned")
            .is_loaded(slot)
    }

    /// The `(injects, provides)` a loaded slot declared. Empty if not loaded.
    pub fn deps_of(&self, slot: &str) -> (Vec<String>, Vec<String>) {
        let reg = match self.registry.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        reg.deps_of(slot)
    }

    /// Declare that a service is provided by the **embedding host** (a dsh
    /// service), so WASM plugins that inject it can activate. The host is
    /// responsible for calling this for each dsh service it exposes.
    pub fn declare_dsh_service(&self, service: &str) {
        let reg = match self.registry.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        reg.add_external_service(service);
    }

    /// Revoke a host-declared service (its dsh provider went away).
    pub fn revoke_dsh_service(&self, service: &str) {
        let mut reg = match self.registry.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let _ = reg.remove_external_service(service);
    }

    /// Every service visible to WASM plugins (its own + host-declared).
    pub fn services(&self) -> Vec<String> {
        let reg = match self.registry.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        reg.services()
    }

    /// Validate a `.wasm` without swapping anything: `(plugin_name, tools)`.
    pub fn validate(&self, path: impl AsRef<Path>) -> Result<(String, Vec<String>)> {
        self.registry
            .lock()
            .expect("registry mutex poisoned")
            .validate(path.as_ref())
    }

    /// The full log ring buffer, oldest first.
    pub fn logs(&self) -> Vec<LogRecord> {
        self.registry
            .lock()
            .expect("registry mutex poisoned")
            .logs()
    }

    /// Log records emitted by one slot, oldest first.
    pub fn logs_for(&self, slot: &str) -> Vec<LogRecord> {
        self.registry
            .lock()
            .expect("registry mutex poisoned")
            .logs_for(slot)
    }

    /// Load every plugin in a [`wasm_plugin_host::config::Config`], skipping
    /// disabled entries. Returns the loaded slot names.
    pub fn load_config(&self, cfg: &wasm_plugin_host::config::Config) -> Vec<(String, Result<LoadedReport>)> {
        let mut out = Vec::new();
        for (slot, entry) in &cfg.plugins {
            if !entry.enabled {
                continue;
            }
            let path = entry.path.clone();
            let config = entry.config_or_null().clone();
            let r = self.load(slot, &path, config);
            out.push((slot.clone(), r));
        }
        out
    }

    /// A snapshot of `slot -> tool names`, handy for asserting on state.
    pub fn tools_by_slot(&self) -> BTreeMap<String, Vec<String>> {
        let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for t in self.list_tools() {
            map.entry(t.slot).or_default().push(t.name);
        }
        map
    }
}

impl std::fmt::Debug for WasmHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (plugins, tools) = match self.registry.try_lock() {
            Ok(reg) => (reg.list_plugins().len(), reg.list_tools().len()),
            Err(_) => (usize::MAX, usize::MAX),
        };
        f.debug_struct("WasmHost")
            .field("plugins", &plugins)
            .field("tools", &tools)
            .finish()
    }
}
