//! Services — plugins as participants that provide and consume capabilities.
//!
//! Two things live here:
//!
//! 1. [`Shared`] — the plugin store and service table, reachable both from the
//!    [`crate::registry::Registry`] *and* from host imports running inside a
//!    guest (`host.call_service`). It is behind `Arc` so a guest can hold it.
//! 2. The **convergence** vocabulary: a plugin declares `injects` (needs) and
//!    `provides` (offers). A plugin whose injects are unmet loads **Pending** and
//!    contributes nothing; once the last needed service appears it **activates**,
//!    registering its own tools/hooks/services — which may in turn satisfy other
//!    waiters (a cascade). Losing a provider deactivates dependents the same way.
//!
//! ## Re-entrancy
//!
//! A service call is a plugin calling into another plugin *while it is itself
//! running*. To make that safe, the **callee** is taken out of the store for the
//! duration of the call and put back afterwards, so the store lock is never held
//! across a guest call and nested calls cannot deadlock. Because the caller is
//! itself out of the store while executing, a direct recursion (A calls B calls
//! A) fails with a clear "busy" error rather than deadlocking or aliasing.

use anyhow::Result;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::plugin::Plugin;

/// The plugin store + service table, shared between the registry and any guest
/// host imports that need to reach other plugins.
pub struct Shared {
    slots: Mutex<HashMap<String, Plugin>>,
    /// service name -> slot that provides it. Only **active** plugins appear.
    providers: Mutex<HashMap<String, String>>,
}

impl Default for Shared {
    fn default() -> Self {
        Self::new()
    }
}

impl Shared {
    pub fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
            providers: Mutex::new(HashMap::new()),
        }
    }

    /// Insert a plugin under `slot`.
    pub fn insert(&self, slot: &str, plugin: Plugin) {
        self.slots.lock().unwrap().insert(slot.to_string(), plugin);
    }

    /// Remove a plugin, handing ownership to the caller.
    ///
    /// Fails if the slot is absent. A slot is absent either because it is not
    /// loaded, or because it is **currently executing** (it was taken out for
    /// the duration of a call) — which is how recursion is refused.
    pub fn take(&self, slot: &str) -> Result<Plugin> {
        self.slots
            .lock()
            .unwrap()
            .remove(slot)
            .ok_or_else(|| {
                anyhow::anyhow!("slot `{slot}` is not available (not loaded, or busy executing)")
            })
    }

    /// Put a taken plugin back.
    pub fn put(&self, slot: &str, plugin: Plugin) {
        self.slots.lock().unwrap().insert(slot.to_string(), plugin);
    }

    pub fn contains(&self, slot: &str) -> bool {
        self.slots.lock().unwrap().contains_key(slot)
    }

    /// Run `f` against the plugin in `slot`, taking it out for the call. The
    /// plugin is put back even if `f` returns an error.
    pub fn with_plugin<R>(&self, slot: &str, f: impl FnOnce(&mut Plugin) -> Result<R>) -> Result<R> {
        let mut plugin = self.take(slot)?;
        let r = f(&mut plugin);
        self.put(slot, plugin);
        r
    }

    /// Register `service` as provided by `slot`.
    pub fn add_provider(&self, service: &str, slot: &str) {
        self.providers
            .lock()
            .unwrap()
            .insert(service.to_string(), slot.to_string());
    }

    /// Drop every service provided by `slot`.
    pub fn remove_providers_of(&self, slot: &str) {
        self.providers.lock().unwrap().retain(|_, owner| owner != slot);
    }

    /// Which slot provides `service`.
    pub fn provider(&self, service: &str) -> Option<String> {
        self.providers.lock().unwrap().get(service).cloned()
    }

    pub fn providers_snapshot(&self) -> HashMap<String, String> {
        self.providers.lock().unwrap().clone()
    }

    /// Call `op` on the plugin providing `service`.
    ///
    /// This is the mechanism behind `host.call_service`: one plugin invoking
    /// another. The callee is taken out of the store for the duration, so nested
    /// service calls work; a recursive call into an already-running plugin fails
    /// with a "busy" error instead of deadlocking.
    pub fn call_service(
        &self,
        service: &str,
        op: &str,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let slot = self
            .provider(service)
            .ok_or_else(|| anyhow::anyhow!("no provider for service `{service}`"))?;
        self.with_plugin(&slot, |p| p.invoke_raw(op, args))
    }

    pub fn len(&self) -> usize {
        self.slots.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A plugin's service dependencies, as recorded by the registry.
#[derive(Debug, Clone, Default)]
pub struct Dependencies {
    pub injects: Vec<String>,
    pub provides: Vec<String>,
}

/// The result of re-evaluating the service graph after a change.
#[derive(Debug, Default)]
pub struct Convergence {
    /// Slots activated (their injects became satisfiable).
    pub activated: Vec<String>,
    /// Slots deactivated (a needed provider disappeared).
    pub deactivated: Vec<String>,
}

impl Convergence {
    pub fn is_empty(&self) -> bool {
        self.activated.is_empty() && self.deactivated.is_empty()
    }
}

/// A convenience alias so callers can hold the store without naming the module.
pub type SharedStore = Arc<Shared>;
