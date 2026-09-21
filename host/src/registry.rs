//! `Registry` — the managing layer over a shared plugin store.
//!
//! A *slot* is a stable identity for a plugin (e.g. `"greet"`); it survives the
//! plugin being rebuilt or renamed internally. This is what lets a running host
//! hot-swap code.
//!
//! Responsibilities:
//! * **Tools** — leaf handlers the flow calls.
//! * **Hooks** — event subscriptions that let a plugin intervene in the flow.
//! * **Services** — capabilities a plugin provides / needs, with **responsive
//!   convergence**: a plugin whose `injects` are unmet stays quiescent, and
//!   activates (registering its tools/hooks/services) the moment the last
//!   provider appears — and deactivates if a provider goes away.
//! * **Atomic reload** — build the replacement fully before tearing down the old.
//!
//! Plugins themselves live in [`crate::service::Shared`] (behind `Arc`), because
//! a running guest must be able to reach other plugins via `host.call_service`.

use anyhow::Result;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::plugin::{Plugin, PluginState, ToolDecl};
use crate::runtime::Runtime;
use crate::service::Shared;

/// A tool as the flow sees it: keyed by `name`, bound to a slot.
#[derive(Clone)]
pub struct RegisteredTool {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
    pub slot: String,
    pub plugin: String,
    pub exec: String,
}

/// Metadata for a loaded slot. The `Plugin` itself lives in [`Shared`].
struct SlotMeta {
    path: PathBuf,
    plugin_name: String,
    /// The config currently applied (diffed by the supervisor).
    config: serde_json::Value,
    injects: Vec<String>,
    provides: Vec<String>,
    /// Whether the plugin's effects are currently registered. A plugin with
    /// unmet injects is loaded but **quiescent** (`active == false`).
    active: bool,
    /// Tools registered while active (so deactivation can unwind precisely).
    owned_tools: Vec<String>,
}

pub struct Registry {
    runtime: Runtime,
    shared: Arc<Shared>,
    meta: HashMap<String, SlotMeta>,
    /// tool name -> registered tool
    tools: HashMap<String, RegisteredTool>,
    hooks: crate::hooks::Hooks,
    /// Shared, bounded log sink.
    log: Arc<crate::state::LogSink>,
}

/// Result of a load or reload.
#[derive(Debug)]
pub struct LoadedReport {
    pub slot: String,
    pub plugin: String,
    pub status: PluginState,
    pub tools: Vec<String>,
    pub hooks: Vec<crate::hooks::Event>,
    pub provides: Vec<String>,
    /// Services it needs that no loaded plugin provides — while non-empty the
    /// plugin is quiescent.
    pub missing_services: Vec<String>,
    /// `true` if the plugin's effects are registered (all injects satisfied).
    pub active: bool,
}

#[derive(Debug)]
pub struct ReloadReport {
    pub slot: String,
    pub old_plugin: String,
    pub new_plugin: String,
    pub old_tools: Vec<String>,
    pub new_tools: Vec<String>,
    pub path_changed: bool,
}

impl Registry {
    pub fn new(runtime: Runtime) -> Self {
        Self::with_logging(runtime, crate::state::DEFAULT_LOG_CAPACITY, true, None)
    }

    pub fn with_logging(
        runtime: Runtime,
        capacity: usize,
        echo_stderr: bool,
        hook: Option<crate::state::LogHook>,
    ) -> Self {
        Self {
            runtime,
            shared: Arc::new(Shared::new()),
            meta: HashMap::new(),
            tools: HashMap::new(),
            hooks: crate::hooks::Hooks::new(),
            log: Arc::new(crate::state::LogSink::new(capacity, echo_stderr, hook)),
        }
    }

    /// The shared store, for wiring into `HostState` so guests can call services.
    pub fn shared(&self) -> Arc<Shared> {
        self.shared.clone()
    }

    pub fn hooks(&self) -> &crate::hooks::Hooks {
        &self.hooks
    }

    pub fn log_sink(&self) -> Arc<crate::state::LogSink> {
        self.log.clone()
    }

    pub fn logs(&self) -> Vec<crate::state::LogRecord> {
        self.log.snapshot()
    }

    pub fn logs_for(&self, slot: &str) -> Vec<crate::state::LogRecord> {
        self.log
            .snapshot()
            .into_iter()
            .filter(|r| r.slot == slot)
            .collect()
    }

    pub fn logs_since(&self, seq: u64) -> Vec<crate::state::LogRecord> {
        self.log.since(seq)
    }

    /// Drop log records below `level`. Applies to records buffered *after* the
    /// call; already-buffered records are untouched.
    pub fn set_log_level(&self, level: crate::state::LogLevel) {
        self.log.set_min_level(level);
    }

    /// The current minimum retained log level.
    pub fn log_level(&self) -> crate::state::LogLevel {
        self.log.min_level()
    }

    /// Snapshot the buffered records older than `level` and drop them too
    /// (used when the level is raised at runtime, so the buffer reflects it).
    pub fn prune_logs_below(&self, level: crate::state::LogLevel) -> usize {
        self.log.prune_below(level)
    }

    pub fn runtime(&self) -> &Runtime {
        &self.runtime
    }

    /// Which slot provides `service`, if any.
    pub fn provider_of(&self, service: &str) -> Option<String> {
        self.shared.provider(service)
    }

    /// Whether a slot's effects are currently registered.
    pub fn is_active(&self, slot: &str) -> bool {
        self.meta.get(slot).map(|m| m.active).unwrap_or(false)
    }

    /// The declaration of a loaded slot: the tools it exposes, the hooks it
    /// subscribes to, and the services it injects/provides.
    ///
    /// Read from the live instance, so it reflects the *current* build. Returns
    /// `None` if the slot is not loaded.
    pub fn decl_of(&self, slot: &str) -> Option<crate::plugin::PluginDecl> {
        self.shared.with_plugin(slot, |p| Ok(p.decl.clone())).ok()
    }

    /// The service names a slot injects / provides (empty if not loaded).
    /// Unlike [`Registry::decl_of`] this never touches the guest instance.
    pub fn deps_of(&self, slot: &str) -> (Vec<String>, Vec<String>) {
        self.meta
            .get(slot)
            .map(|m| (m.injects.clone(), m.provides.clone()))
            .unwrap_or_default()
    }

    /// Call `op` on whichever slot provides `service` — the same mechanism as
    /// the guest's `host.call_service`, exposed to host-side callers (used to
    /// back a dsh service a wasm plugin offers).
    pub fn call_service(
        &self,
        service: &str,
        op: &str,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.shared.call_service(service, op, args)
    }

    /// Declare a service as provided by the embedding host (e.g. a dsh service),
    /// so WASM plugins that inject it can activate.
    pub fn add_external_service(&self, service: &str) {
        self.shared.add_external_provider(service);
    }

    /// Revoke a host-provided service and re-converge (dependents deactivate).
    pub fn remove_external_service(&mut self, service: &str) -> crate::service::Convergence {
        self.shared.remove_external_provider(service);
        self.converge()
    }

    /// Every service visible to WASM plugins (WASM-provided + host-provided).
    pub fn services(&self) -> Vec<String> {
        self.shared.all_services()
    }

    /// Activate a slot **without** consulting its `injects`.
    ///
    /// Used when an outer framework already proved the slot's dependencies are
    /// met — in `dsh-wasm-host`, cordis gates activation (its `inject` list
    /// spans both dsh services and other slots' `provides`), and the WASM
    /// registry must simply reflect that decision. Registers the slot's tools,
    /// hooks, and provided services. Returns `false` if already active.
    pub fn force_activate(&mut self, slot: &str) -> bool {
        self.activate(slot)
    }

    /// Deactivate a slot unconditionally, unwinding its tools/hooks/services.
    /// Returns the tool names removed.
    pub fn force_deactivate(&mut self, slot: &str) -> Vec<String> {
        self.deactivate(slot)
    }

    /// Load a plugin into `slot`.
    pub fn load(
        &mut self,
        slot: &str,
        path: &Path,
        config: serde_json::Value,
    ) -> Result<LoadedReport> {
        if self.meta.contains_key(slot) {
            anyhow::bail!("slot `{slot}` is already occupied");
        }
        let plugin = self.build_plugin(slot, path, config.clone())?;
        let plugin_name = plugin.decl.name.clone();
        let injects = plugin.decl.injects.clone();
        let provides = plugin.decl.provides.clone();
        let tool_names: Vec<String> = plugin.tools().iter().map(|t| t.name.clone()).collect();

        // Validate tool names against *other* slots before committing.
        for name in &tool_names {
            if let Some(owner) = self.tools.get(name) {
                anyhow::bail!(
                    "tool `{name}` from slot `{slot}` is already registered by `{}`",
                    owner.slot
                );
            }
        }
        // Services must not clash with another active provider.
        for svc in &provides {
            if let Some(owner) = self.shared.provider(svc) {
                anyhow::bail!("service `{svc}` is already provided by slot `{owner}`");
            }
        }
        // Hook events must be part of the known vocabulary.
        for h in &plugin.decl.hooks {
            if crate::hooks::Event::parse(&h.on).is_none() {
                anyhow::bail!("slot `{slot}` subscribes to unknown event `{}`", h.on);
            }
        }

        self.shared.insert(slot, plugin);
        self.meta.insert(
            slot.to_string(),
            SlotMeta {
                path: std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()),
                plugin_name: plugin_name.clone(),
                config,
                injects: injects.clone(),
                provides,
                active: false,
                owned_tools: Vec::new(),
            },
        );

        // Converge: this may activate the new slot and cascade to others.
        let conv = self.converge();

        let m = &self.meta[slot];
        let missing: Vec<String> = m
            .injects
            .iter()
            .filter(|s| self.shared.provider(s).is_none())
            .cloned()
            .collect();
        let active = m.active;
        let tools: Vec<String> = self
            .tools
            .values()
            .filter(|t| t.slot == slot)
            .map(|t| t.name.clone())
            .collect();
        let hooks: Vec<crate::hooks::Event> = self
            .hooks
            .subscribers_all()
            .into_iter()
            .filter(|s| s.slot == slot)
            .map(|s| s.event)
            .collect();
        let provides = m.provides.clone();
        let _ = conv;

        Ok(LoadedReport {
            slot: slot.to_string(),
            plugin: plugin_name,
            status: PluginState::Active,
            tools,
            hooks,
            provides,
            missing_services: missing,
            active,
        })
    }

    /// Unload a slot: unwind its effects and drop the instance (real release).
    pub fn unload(&mut self, slot: &str) -> Result<Vec<String>> {
        let removed = self.deactivate(slot);
        self.meta
            .remove(slot)
            .ok_or_else(|| anyhow::anyhow!("no such slot `{slot}`"))?;
        let mut plugin = self.shared.take(slot)?;
        plugin.shutdown();
        drop(plugin);
        // Unloading a provider may leave dependents without their deps.
        self.converge();
        Ok(removed)
    }

    /// Atomically replace the wasm backing `slot`.
    pub fn reload(
        &mut self,
        slot: &str,
        path: &Path,
        config: Option<serde_json::Value>,
    ) -> Result<ReloadReport> {
        let old = self
            .meta
            .get(slot)
            .ok_or_else(|| anyhow::anyhow!("no such slot `{slot}`"))?;
        let old_plugin = old.plugin_name.clone();
        let old_path = old.path.clone();
        let effective_config = config.unwrap_or_else(|| old.config.clone());
        let old_tools: Vec<String> = old.owned_tools.clone();

        // ---- Stage 1: build & validate the replacement, untouched ----
        let new_plugin = self.build_plugin(slot, path, effective_config.clone())?;
        let new_plugin_name = new_plugin.decl.name.clone();
        let new_tool_names: Vec<String> = new_plugin.tools().iter().map(|t| t.name.clone()).collect();

        for name in &new_tool_names {
            if let Some(owner) = self.tools.get(name) {
                if owner.slot != slot {
                    anyhow::bail!(
                        "reload rejected: tool `{name}` collides with slot `{}`",
                        owner.slot
                    );
                }
            }
        }
        for svc in &new_plugin.decl.provides {
            if let Some(owner) = self.shared.provider(svc) {
                if owner != slot {
                    anyhow::bail!("reload rejected: service `{svc}` is provided by slot `{owner}`");
                }
            }
        }
        for h in &new_plugin.decl.hooks {
            if crate::hooks::Event::parse(&h.on).is_none() {
                anyhow::bail!("reload rejected: unknown event `{}`", h.on);
            }
        }

        // ---- Stage 2: commit. Nothing below can fail. ----
        self.deactivate(slot);
        let mut old_plugin_inst = self.shared.take(slot)?;
        old_plugin_inst.shutdown();
        drop(old_plugin_inst);

        self.shared.insert(slot, new_plugin);
        {
            let m = self.meta.get_mut(slot).unwrap();
            m.path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            m.plugin_name = new_plugin_name.clone();
            m.config = effective_config;
            m.injects = self
                .shared
                .with_plugin(slot, |p| Ok(p.decl.injects.clone()))
                .unwrap_or_default();
            m.provides = self
                .shared
                .with_plugin(slot, |p| Ok(p.decl.provides.clone()))
                .unwrap_or_default();
            m.active = false;
            m.owned_tools.clear();
        }
        self.converge();

        let new_tools: Vec<String> = self
            .tools
            .values()
            .filter(|t| t.slot == slot)
            .map(|t| t.name.clone())
            .collect();

        Ok(ReloadReport {
            slot: slot.to_string(),
            old_plugin,
            new_plugin: new_plugin_name,
            old_tools,
            new_tools,
            path_changed: old_path
                != std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()),
        })
    }

    /// Push a new config to a live slot without reloading it.
    pub fn apply_config(&mut self, slot: &str, config: serde_json::Value) -> Result<bool> {
        let current_differs = self
            .meta
            .get(slot)
            .map(|m| m.config != config)
            .unwrap_or(false);
        if !current_differs {
            return Ok(false);
        }
        let consumed = self.shared.with_plugin(slot, |p| p.set_config(config.clone()))?;
        if let Some(m) = self.meta.get_mut(slot) {
            m.config = config;
        }
        Ok(consumed)
    }

    pub fn slot_config(&self, slot: &str) -> Option<&serde_json::Value> {
        self.meta.get(slot).map(|m| &m.config)
    }

    pub fn slot_has_config_hook(&self, slot: &str) -> bool {
        self.shared
            .with_plugin(slot, |p| Ok(p.has_config_hook()))
            .unwrap_or(false)
    }

    pub fn slot_path(&self, slot: &str) -> Option<PathBuf> {
        self.meta.get(slot).map(|m| m.path.clone())
    }

    pub fn is_loaded(&self, slot: &str) -> bool {
        self.meta.contains_key(slot)
    }

    /// Override the `host.http_fetch` bound for plugins loaded from now on.
    pub fn set_http_timeout(&mut self, timeout: std::time::Duration) -> &mut Self {
        self.runtime.set_http_timeout(timeout);
        self
    }

    pub fn list_plugins(&self) -> Vec<(String, String, PluginState, usize, bool)> {
        let mut v: Vec<_> = self
            .meta
            .iter()
            .map(|(k, m)| {
                let tools = self.tools.values().filter(|t| &t.slot == k).count();
                (
                    k.clone(),
                    m.plugin_name.clone(),
                    if m.active {
                        PluginState::Active
                    } else {
                        PluginState::Pending
                    },
                    tools,
                    m.active,
                )
            })
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }

    pub fn list_tools(&self) -> Vec<&RegisteredTool> {
        let mut v: Vec<_> = self.tools.values().collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    pub fn tool_owner(&self, tool: &str) -> Option<&str> {
        self.tools.get(tool).map(|t| t.slot.as_str())
    }

    /// Validate a build without loading it.
    pub fn validate(&self, path: &Path) -> Result<(String, Vec<String>)> {
        let p = self.build_plugin("<validate>", path, serde_json::Value::Null)?;
        Ok((
            p.decl.name.clone(),
            p.tools().iter().map(|t| t.name.clone()).collect(),
        ))
    }

    /// Call a tool by name — the flow entry point.
    pub fn call_tool(&mut self, tool: &str, args: &serde_json::Value) -> Result<serde_json::Value> {
        let (slot, exec) = {
            let t = self
                .tools
                .get(tool)
                .ok_or_else(|| anyhow::anyhow!("no such tool `{tool}`"))?;
            (t.slot.clone(), t.exec.clone())
        };
        let res = self.shared.with_plugin(&slot, |p| p.invoke(&exec, args))?;
        Ok(serde_json::to_value(res)?)
    }

    /// Dispatch a flow event through subscribed plugins (waterfalls intervene).
    pub fn dispatch(
        &mut self,
        ev: crate::hooks::Event,
        value: serde_json::Value,
    ) -> crate::hooks::Dispatch {
        if !self.hooks.has_subscribers(ev) {
            return crate::hooks::Dispatch {
                value,
                vetoed_by: None,
                ran: 0,
                errored: Vec::new(),
            };
        }
        let subs = self.hooks.subscribers(ev);
        let mut ran = 0usize;
        let mut errored = Vec::new();
        let mut vetoed_by = None;
        let mut current = value;

        for sub in subs {
            ran += 1;
            let payload = serde_json::json!({ "event": ev.as_str(), "value": current });
            let reply = self.shared.with_plugin(&sub.slot, |p| p.invoke_raw(&sub.exec, &payload));
            match reply {
                Ok(r) => {
                    if sub.mode == crate::plugin::HookMode::Waterfall {
                        match crate::hooks::Decision::parse(&r) {
                            crate::hooks::Decision::Continue => {}
                            crate::hooks::Decision::Rewrite { value: v } => current = v,
                            crate::hooks::Decision::Veto { .. } => {
                                vetoed_by = Some(sub.slot.clone());
                                break;
                            }
                        }
                    }
                }
                Err(_) => errored.push(sub.slot.clone()),
            }
        }

        crate::hooks::Dispatch {
            value: current,
            vetoed_by,
            ran,
            errored,
        }
    }

    /// Run several tool calls concurrently, one thread per plugin.
    ///
    /// Calls to *different* slots run in parallel; calls to the *same* slot are
    /// serialized. Results are returned in input order.
    pub fn call_many_parallel(
        &mut self,
        calls: &[(&str, serde_json::Value)],
    ) -> Vec<Result<serde_json::Value>> {
        let mut resolved: Vec<Result<(String, String)>> = Vec::with_capacity(calls.len());
        let mut involved: Vec<String> = Vec::new();
        for (tool, _) in calls {
            match self.tools.get(*tool) {
                Some(t) => {
                    if !involved.contains(&t.slot) {
                        involved.push(t.slot.clone());
                    }
                    resolved.push(Ok((t.slot.clone(), t.exec.clone())));
                }
                None => resolved.push(Err(anyhow::anyhow!("no such tool `{tool}`"))),
            }
        }

        // Take each involved plugin out of the shared store so a thread can own
        // it. Restored afterwards.
        let mut taken: Vec<(String, Plugin)> = Vec::new();
        for slot in &involved {
            if let Ok(p) = self.shared.take(slot) {
                taken.push((slot.clone(), p));
            }
        }

        let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, r) in resolved.iter().enumerate() {
            if let Ok((slot, _)) = r {
                groups.entry(slot.clone()).or_default().push(i);
            }
        }

        let mut slots_out: Vec<(String, Plugin, Vec<(usize, Result<serde_json::Value>)>)> =
            Vec::new();
        std::thread::scope(|scope| {
            let handles: Vec<_> = taken
                .into_iter()
                .map(|(slot, mut plugin)| {
                    let indices = groups.remove(&slot).unwrap_or_default();
                    let resolved = &resolved;
                    scope.spawn(move || {
                        let mut out = Vec::with_capacity(indices.len());
                        for idx in indices {
                            let exec = match &resolved[idx] {
                                Ok((_, exec)) => exec.clone(),
                                Err(_) => continue,
                            };
                            let r = plugin
                                .invoke(&exec, &calls[idx].1)
                                .and_then(|v| serde_json::to_value(v).map_err(Into::into));
                            out.push((idx, r));
                        }
                        (slot, plugin, out)
                    })
                })
                .collect();
            for h in handles {
                slots_out.push(h.join().expect("plugin worker panicked"));
            }
        });

        let mut ordered: Vec<Option<Result<serde_json::Value>>> =
            (0..calls.len()).map(|_| None).collect();
        for (slot, plugin, results) in slots_out {
            for (idx, r) in results {
                ordered[idx] = Some(r);
            }
            self.shared.put(&slot, plugin);
        }

        ordered
            .into_iter()
            .enumerate()
            .map(|(i, o)| match o {
                Some(r) => r,
                None => match &resolved[i] {
                    Err(e) => Err(anyhow::anyhow!("{e}")),
                    Ok(_) => Err(anyhow::anyhow!("call produced no result")),
                },
            })
            .collect()
    }

    // ---- internals ----

    fn build_plugin(
        &self,
        slot: &str,
        path: &Path,
        config: serde_json::Value,
    ) -> Result<Plugin> {
        let engine = self.runtime.engine().clone();
        Plugin::load(
            &engine,
            path,
            &self.runtime,
            slot,
            config,
            self.log.clone(),
            Some(self.shared.clone()),
        )
    }

    /// (Re)compute the active set to a fixpoint.
    ///
    /// A slot is **active** iff every service it injects is provided by some
    /// **currently active** slot (a slot may also satisfy its own injects by
    /// what it provides). Activating registers that slot's tools, hooks, and
    /// services; a newly-registered service can satisfy another slot's injects,
    /// so we iterate. Losing a provider cascades deactivation the same way.
    fn converge(&mut self) -> crate::service::Convergence {
        let mut conv = crate::service::Convergence::default();

        loop {
            let mut changed = false;

            // Deactivate first: if a provider went away, dependents must stop
            // before we consider anyone newly-ready.
            let stale: Vec<String> = self
                .meta
                .iter()
                .filter(|(_, m)| m.active)
                .filter(|(slot, m)| {
                    m.injects
                        .iter()
                        .any(|svc| !self.service_available(slot, svc))
                })
                .map(|(s, _)| s.clone())
                .collect();
            for slot in stale {
                self.deactivate(&slot);
                conv.deactivated.push(slot);
                changed = true;
            }

            // Activate anyone whose injects are all satisfiable now.
            let ready: Vec<String> = self
                .meta
                .iter()
                .filter(|(_, m)| !m.active)
                .filter(|(slot, m)| {
                    m.injects.iter().all(|svc| self.service_available(slot, svc))
                })
                .map(|(s, _)| s.clone())
                .collect();
            for slot in ready {
                if self.activate(&slot) {
                    conv.activated.push(slot);
                    changed = true;
                }
            }

            if !changed {
                break;
            }
        }

        conv
    }

    /// Is `service` available to `slot`? It is if any active slot provides it,
    /// if the embedding host declares it external, or if `slot` itself provides it.
    fn service_available(&self, slot: &str, service: &str) -> bool {
        if self.meta.get(slot).map(|m| m.provides.iter().any(|s| s == service)).unwrap_or(false) {
            return true;
        }
        if self.shared.is_external(service) {
            return true;
        }
        self.shared
            .provider(service)
            .map(|owner| self.meta.get(&owner).map(|m| m.active).unwrap_or(false))
            .unwrap_or(false)
    }

    /// Register a slot's effects. Returns true if it actually became active.
    fn activate(&mut self, slot: &str) -> bool {
        let (plugin_name, tools, hooks, provides) = {
            let m = match self.meta.get(slot) {
                Some(m) if !m.active => m,
                _ => return false,
            };
            let plugin_name = m.plugin_name.clone();
            let provides = m.provides.clone();
            let decl_tools = self
                .shared
                .with_plugin(slot, |p| Ok(p.tools().to_vec()))
                .unwrap_or_default();
            let decl_hooks = self
                .shared
                .with_plugin(slot, |p| Ok(p.decl.hooks.clone()))
                .unwrap_or_default();
            (plugin_name, decl_tools, decl_hooks, provides)
        };
        let _ = plugin_name;

        // Register tools.
        let mut owned = Vec::new();
        for t in &tools {
            self.tools.insert(
                t.name.clone(),
                RegisteredTool {
                    name: t.name.clone(),
                    description: t.description.clone(),
                    parameters: t.parameters.clone(),
                    slot: slot.to_string(),
                    plugin: self.meta[slot].plugin_name.clone(),
                    exec: t.exec.clone(),
                },
            );
            owned.push(t.name.clone());
        }
        // Register hooks.
        let _ = self.hooks.add_slot(slot, &self.meta[slot].plugin_name, &hooks);
        // Register services.
        for svc in &provides {
            self.shared.add_provider(svc, slot);
        }

        if let Some(m) = self.meta.get_mut(slot) {
            m.active = true;
            m.owned_tools = owned;
        }
        true
    }

    /// Unwind a slot's effects. Returns the tool names removed.
    fn deactivate(&mut self, slot: &str) -> Vec<String> {
        let owned = match self.meta.get(slot) {
            Some(m) if m.active => m.owned_tools.clone(),
            _ => Vec::new(),
        };
        for name in &owned {
            self.tools.remove(name);
        }
        self.hooks.remove_slot(slot);
        self.shared.remove_providers_of(slot);
        if let Some(m) = self.meta.get_mut(slot) {
            m.active = false;
            m.owned_tools.clear();
        }
        owned
    }
}

/// Tool names a declaration exposes; helper for reports.
#[allow(dead_code)]
fn tool_names(decls: &[ToolDecl]) -> Vec<String> {
    decls.iter().map(|t| t.name.clone()).collect()
}

/// Set difference helper used in reports.
#[allow(dead_code)]
fn missing<'a>(needed: &'a [String], have: &HashSet<String>) -> Vec<String> {
    needed.iter().filter(|s| !have.contains(*s)).cloned().collect()
}
