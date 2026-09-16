//! Mount WASM plugins into a dsh harness — **one cordis plugin per slot**.
//!
//! This is the "everything is a plugin" mapping taken seriously: each WASM slot
//! is mounted as its **own** cordis plugin, so it gets
//!
//! * its own **fiber** (independent lifecycle, its own convergence state),
//! * its own **`inject`** list — a slot that needs `sessions` stays PENDING
//!   until that service is live, exactly like a native dsh plugin,
//! * its own **`provide`** — a slot that provides `memory` publishes a
//!   [`WasmService`] on the context that other dsh plugins (native or WASM) can
//!   `ctx.require::<WasmService>("memory")` and call.
//!
//! A single separate [`FlowBridgePlugin`] installs the shared flow bridge (the
//! intervention waterfalls and the `session/event` fan-out); that is a property
//! of the host as a whole, not of any one slot.
//!
//! ## How a slot'`inject` list becomes a cordis dependency
//!
//! A WASM slot declares `injects: ["sessions"]`. Two things then have to agree
//! that `sessions` is available:
//!
//! 1. **cordis** — the slot's fiber declares `Injection::new("sessions")`, so it
//!    is gated on a service of that name existing on the context.
//! 2. **the WASM registry** — the registry's own convergence must not *also*
//!    quiesce the slot. Services provided by dsh are registered with the
//!    registry as **external** ([`crate::host::WasmHost::declare_dsh_service`]),
//!    so the registry accepts them as satisfied.
//!
//! cordis is the authoritative gate; the registry's [`force_activate`] mirrors
//! cordis's decision rather than re-deriving it.

use std::sync::Arc;

use cordis::plugin::{BoxFuture, Injection, Plugin};
use cordis::{Context, FiberHandle};
use dsh_rs::api::services::{DynamicToolSpec, ToolsService, TOOLS_SERVICE};
use dsh_rs::types::ToolExecutionResult;
use serde_json::Value;

use crate::bridge;
use crate::host::{WasmHost, WasmToolInfo};

/// One plugin to load at install time.
#[derive(Debug, Clone)]
pub struct LoadSpec {
    /// Stable slot identity (survives the `.wasm` being rebuilt).
    pub slot: String,
    /// Path to the `.wasm` (relative paths resolve against the process CWD).
    pub path: String,
    /// JSON injected into the guest via `plugin_configure`.
    pub config: Value,
}

impl LoadSpec {
    pub fn new(slot: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            slot: slot.into(),
            path: path.into(),
            config: Value::Null,
        }
    }

    pub fn with_config(mut self, config: Value) -> Self {
        self.config = config;
        self
    }
}

/// The value a WASM slot publishes for each service it `provides`.
///
/// dsh plugins obtain it with `ctx.require::<WasmService>("<name>")` and call it
/// with [`WasmService::call`]; the call crosses into the guest as
/// JSON-over-linear-memory and comes back as JSON, so the guest can be written
/// in any WASI language.
#[derive(Clone)]
pub struct WasmService {
    /// The service name as declared by the slot's `provides`.
    pub name: String,
    /// The slot that provides it.
    pub slot: String,
    host: WasmHost,
}

impl WasmService {
    pub fn new(name: impl Into<String>, slot: impl Into<String>, host: WasmHost) -> Self {
        Self {
            name: name.into(),
            slot: slot.into(),
            host,
        }
    }

    /// Call `op` on the providing slot with JSON `args`; returns its JSON reply.
    ///
    /// Runs on the blocking pool (wasmtime calls are synchronous), so callers may
    /// `.await` it from an async dsh plugin without stalling the runtime.
    pub async fn call(&self, op: &str, args: Value) -> anyhow::Result<Value> {
        let host = self.host.clone();
        let service = self.name.clone();
        let op = op.to_string();
        tokio::task::spawn_blocking(move || {
            let registry = host.registry();
            let reg = match registry.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            reg.call_service(&service, &op, &args)
        })
        .await
        .map_err(|e| anyhow::anyhow!("wasm service task failed: {e}"))?
    }

    /// Is the providing slot still loaded?
    pub fn is_live(&self) -> bool {
        self.host.is_loaded(&self.slot)
    }
}

impl std::fmt::Debug for WasmService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WasmService")
            .field("name", &self.name)
            .field("slot", &self.slot)
            .finish()
    }
}

/// What a slot fiber's disposer does to the guest registry when the fiber
/// unloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnDispose {
    /// Unload the guest, releasing the wasmtime instance (code + linear memory).
    ///
    /// The default: for a host where "the fiber is disposed" and "the plugin is
    /// gone" mean the same thing ([`install`]).
    Unload,
    /// Only deactivate the slot in the registry — unregister its tools, hooks
    /// and services — but keep the guest instance loaded.
    ///
    /// For a host that manages the guest lifecycle itself and needs the instance
    /// to outlive a fiber remount. In particular a hot reload must: dispose the
    /// fiber (so dsh drops the old tools/services), swap the guest's code, then
    /// remount — which is impossible if disposing also destroyed the instance.
    KeepLoaded,
}

/// One cordis plugin per WASM slot.
pub struct WasmSlotPlugin {
    slot: String,
    host: WasmHost,
    on_dispose: OnDispose,
}

impl WasmSlotPlugin {
    /// A slot whose fiber disposes by **unloading** the guest.
    pub fn new(slot: impl Into<String>, host: WasmHost) -> Self {
        Self {
            slot: slot.into(),
            host,
            on_dispose: OnDispose::Unload,
        }
    }

    /// A slot whose fiber disposes by only **deactivating** in the registry,
    /// leaving the guest instance loaded for the caller to manage.
    pub fn keeping_loaded(slot: impl Into<String>, host: WasmHost) -> Self {
        Self {
            slot: slot.into(),
            host,
            on_dispose: OnDispose::KeepLoaded,
        }
    }

    /// What this slot does to the guest when its fiber is disposed.
    pub fn on_dispose(&self) -> OnDispose {
        self.on_dispose
    }
}

impl std::fmt::Debug for WasmSlotPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WasmSlotPlugin")
            .field("slot", &self.slot)
            .finish()
    }
}

impl Plugin for WasmSlotPlugin {
    fn name(&self) -> std::borrow::Cow<'static, str> {
        std::borrow::Cow::Owned(format!("wasm:{}", self.slot))
    }

    fn inject(&self) -> Vec<Injection> {
        // Always need the tool registry to register into; plus whatever the
        // guest declared, mapped one-to-one onto cordis service names.
        let mut deps = vec![Injection::new(TOOLS_SERVICE)];
        let (injects, _) = self.host.deps_of(&self.slot);
        for svc in injects {
            deps.push(Injection::new(svc));
        }
        deps
    }

    fn apply(&self, ctx: Context, _config: Value) -> BoxFuture<cordis::Result<()>> {
        let host = self.host.clone();
        let slot = self.slot.clone();
        // Read `on_dispose` before entering the async block so the future does
        // not borrow `self`.
        let on_dispose = self.on_dispose;
        Box::pin(async move {
            let tools = ctx
                .require::<ToolsService>(TOOLS_SERVICE)
                .map_err(|e| cordis::Error::msg(format!("tools service missing: {e}")))?;

            // cordis has already proven this slot's dependencies are met, so
            // mirror that decision into the WASM registry (which owns the actual
            // guest instances, tools map and hooks table).
            {
                let registry = host.registry();
                let mut reg = match registry.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                reg.force_activate(&slot);
            }

            // Register this slot's tools on dsh's tool registry.
            let mine: Vec<WasmToolInfo> = host
                .list_tools()
                .into_iter()
                .filter(|t| t.slot == slot)
                .collect();
            let mut registered = Vec::new();
            for info in &mine {
                register_one(&tools, &host, info);
                registered.push(info.name.clone());
            }

            // Publish each service the slot `provides`, so native dsh plugins
            // (and other slots) can inject it.
            let (_, provides) = host.deps_of(&slot);
            let mut provided = Vec::new();
            for svc in provides {
                let handle = WasmService::new(svc.clone(), slot.clone(), host.clone());
                ctx.provide(svc.as_str(), handle).await.map_err(|e| {
                    cordis::Error::msg(format!("slot `{slot}` could not provide `{svc}`: {e}"))
                })?;
                provided.push(svc);
            }

            // Unwind everything on unload, in reverse.
            let tools_for_dispose = tools.clone();
            let host_for_dispose = host.clone();
            let slot_for_dispose = slot.clone();
            let provided_for_dispose = provided.clone();
            ctx.effect(format!("wasm slot {slot}"), async move {
                let disposer: cordis::Disposer = Box::new(move || {
                    let tools = tools_for_dispose.clone();
                    let host = host_for_dispose.clone();
                    let slot = slot_for_dispose.clone();
                    let _ = provided_for_dispose; // withdrawn by the fiber's own provide-effects
                    Box::pin(async move {
                        // Withdraw this slot's tools from the dsh registry. Its
                        // `provide`d services are withdrawn by the fiber's own
                        // provide-effects, which unwind alongside this one.
                        for name in registered {
                            tools.unregister_dynamic_tool(&name);
                        }
                        let registry = host.registry();
                        let mut reg = match registry.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        match on_dispose {
                            // Deactivate in the WASM registry but keep the guest
                            // instance loaded for the caller to manage.
                            OnDispose::KeepLoaded => {
                                reg.force_deactivate(&slot);
                            }
                            // Fully unload: drops the wasmtime instance so the
                            // guest's code AND linear memory are really released.
                            // That is the reason this host exists — a disposed
                            // slot must not leak a live instance.
                            OnDispose::Unload => {
                                let _ = reg.unload(&slot);
                            }
                        }
                    })
                });
                Ok(Some(disposer))
            })
            .await?;

            ctx.logger().log_event(
                cordis::LogLevel::Info,
                "wasm-plugin".to_string(),
                None,
                format!(
                    "slot `{slot}` active ({} tool(s), {} service(s))",
                    mine.len(),
                    provided.len()
                ),
            );
            Ok(())
        })
    }
}

/// The single host-wide plugin that installs the flow bridge.
pub struct FlowBridgePlugin {
    host: WasmHost,
}

impl FlowBridgePlugin {
    pub fn new(host: WasmHost) -> Self {
        Self { host }
    }
}

impl std::fmt::Debug for FlowBridgePlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FlowBridgePlugin").finish()
    }
}

impl Plugin for FlowBridgePlugin {
    fn name(&self) -> std::borrow::Cow<'static, str> {
        std::borrow::Cow::Borrowed("wasm-flow-bridge")
    }

    fn inject(&self) -> Vec<Injection> {
        // The bridge registers listeners on the event bus and dispatches into
        // the registry; it needs no dsh service, but gating on `tools` keeps it
        // from activating before the harness is up (matching the old behaviour).
        vec![Injection::new(TOOLS_SERVICE)]
    }

    fn apply(&self, ctx: Context, _config: Value) -> BoxFuture<cordis::Result<()>> {
        let host = self.host.clone();
        Box::pin(async move {
            bridge::install_flow_bridge(&ctx, &host)
                .await
                .map_err(|e| cordis::Error::msg(format!("flow bridge: {e}")))?;
            Ok(())
        })
    }
}

/// What [`install`] mounted: the per-slot fibers (so a caller can reload or
/// dispose one slot) and the shared bridge fiber.
pub struct Mounted {
    pub host: WasmHost,
    /// slot -> its fiber handle.
    pub slots: Vec<(String, FiberHandle)>,
    pub bridge: FiberHandle,
}

impl Mounted {
    /// The fiber for one slot, if it was mounted.
    pub fn slot_fiber(&self, slot: &str) -> Option<&FiberHandle> {
        self.slots
            .iter()
            .find(|(s, _)| s == slot)
            .map(|(_, f)| f)
    }

    /// Unmount everything: unload each slot then tear down the bridge.
    pub async fn dispose(&self) {
        for (_, fiber) in &self.slots {
            fiber.dispose().await;
        }
        self.bridge.dispose().await;
    }
}

impl std::fmt::Debug for Mounted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Mounted")
            .field("slots", &self.slots.iter().map(|(s, _)| s).collect::<Vec<_>>())
            .finish()
    }
}

/// Load `specs` into `host`, then mount **one cordis plugin per slot** plus the
/// shared flow bridge.
pub async fn install(
    ctx: &Context,
    host: WasmHost,
    specs: Vec<LoadSpec>,
) -> anyhow::Result<Mounted> {
    // Load all guests first so each slot plugin can read its declaration.
    for spec in &specs {
        host.load(&spec.slot, &spec.path, spec.config.clone())
            .map_err(|e| anyhow::anyhow!("loading `{}` for slot `{}`: {e}", spec.path, spec.slot))?;
    }

    // Mount the bridge once.
    let bridge_plugin: Arc<dyn Plugin> = Arc::new(FlowBridgePlugin::new(host.clone()));
    let bridge = ctx.plugin(bridge_plugin, None);
    bridge
        .join()
        .await
        .map_err(|e| anyhow::anyhow!("flow bridge fiber failed to converge: {e}"))?;

    // Mount one plugin per slot, in load order.
    let mut slots = Vec::new();
    for spec in &specs {
        let plugin: Arc<dyn Plugin> =
            Arc::new(WasmSlotPlugin::new(spec.slot.clone(), host.clone()));
        let fiber = ctx.plugin(plugin, None);
        // A slot whose injects are unmet stays PENDING — that is correct dsh
        // behaviour, not an error. We only surface a *failed* startup.
        if let Err(e) = fiber.join().await {
            return Err(anyhow::anyhow!(
                "slot `{}` fiber failed to start: {e}",
                spec.slot
            ));
        }
        slots.push((spec.slot.clone(), fiber));
    }

    Ok(Mounted {
        host,
        slots,
        bridge,
    })
}

/// Re-synchronise dsh's tool registry with a slot's current tool set (after a
/// hot reload changed the slot's declared tools). Returns `(added, removed)`.
pub fn resync_slot_tools(
    tools: &ToolsService,
    host: &WasmHost,
    slot: &str,
    tracked: &mut Vec<String>,
) -> (Vec<String>, Vec<String>) {
    let current: Vec<WasmToolInfo> = host
        .list_tools()
        .into_iter()
        .filter(|t| t.slot == slot)
        .collect();
    let current_names: Vec<String> = current.iter().map(|t| t.name.clone()).collect();

    let removed: Vec<String> = tracked
        .iter()
        .filter(|n| !current_names.contains(n))
        .cloned()
        .collect();
    for name in &removed {
        tools.unregister_dynamic_tool(name);
    }

    let added: Vec<String> = current_names
        .iter()
        .filter(|n| !tracked.contains(n))
        .cloned()
        .collect();
    for info in &current {
        if added.contains(&info.name) {
            register_one(tools, host, info);
        }
    }

    *tracked = current_names;
    (added, removed)
}

/// Back-compat shim for the previous all-slots-in-one helper.
pub fn resync_tools(
    tools: &ToolsService,
    host: &WasmHost,
    tracked: &mut Vec<String>,
) -> (Vec<String>, Vec<String>) {
    let current = host.list_tools();
    let current_names: Vec<String> = current.iter().map(|t| t.name.clone()).collect();

    let removed: Vec<String> = tracked
        .iter()
        .filter(|n| !current_names.contains(n))
        .cloned()
        .collect();
    for name in &removed {
        tools.unregister_dynamic_tool(name);
    }
    let added: Vec<String> = current_names
        .iter()
        .filter(|n| !tracked.contains(n))
        .cloned()
        .collect();
    for info in &current {
        if added.contains(&info.name) {
            register_one(tools, host, info);
        }
    }
    *tracked = current_names;
    (added, removed)
}

/// Register a single WASM tool as a dsh dynamic tool.
fn register_one(tools: &ToolsService, host: &WasmHost, info: &WasmToolInfo) {
    let host = host.clone();
    let tool_name = info.name.clone();
    let spec = DynamicToolSpec {
        name: info.name.clone(),
        description: info.description.clone(),
        parameters: info.parameters.clone(),
        exec: Arc::new(move |arguments: Value| {
            let host = host.clone();
            let tool_name = tool_name.clone();
            Box::pin(async move {
                let args = arguments.clone();
                match tokio::task::spawn_blocking(move || host.call_tool(&tool_name, &args)).await {
                    Ok(Ok(reply)) => guest_reply_to_result(reply),
                    Ok(Err(e)) => ToolExecutionResult::error("WASM_CALL", e.to_string()),
                    Err(join) => ToolExecutionResult::error(
                        "WASM_JOIN",
                        format!("wasm tool task failed: {join}"),
                    ),
                }
            })
        }),
    };
    tools.register_dynamic_tool(spec);
}

/// Map a guest's `plugin_invoke` reply (`{"kind":"success"|"error",…}`) onto a
/// dsh tool result.
fn guest_reply_to_result(reply: Value) -> ToolExecutionResult {
    match reply.get("kind").and_then(|k| k.as_str()) {
        Some("success") => {
            let content = reply
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("ok")
                .to_string();
            let value = reply.get("value").cloned().unwrap_or(Value::Null);
            ToolExecutionResult::success_text(content, value)
        }
        Some("error") => {
            let message = reply
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("wasm plugin error")
                .to_string();
            let code = reply
                .get("code")
                .and_then(|c| c.as_str())
                .filter(|c| !c.is_empty())
                .unwrap_or("PLUGIN_ERROR")
                .to_string();
            ToolExecutionResult::error(code, message)
        }
        _ => ToolExecutionResult::error(
            "BAD_REPLY",
            format!("guest returned an unrecognised reply: {reply}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dsh_rs::types::ContentBlock;
    use serde_json::json;

    #[test]
    fn success_reply_maps_to_success_text() {
        let r = guest_reply_to_result(json!({
            "kind": "success",
            "content": "hello",
            "value": { "n": 1 }
        }));
        match r {
            ToolExecutionResult::Success { content, value, .. } => {
                let text: String = content.iter().filter_map(|b| b.as_text()).collect();
                assert_eq!(text, "hello");
                assert_eq!(value["n"], 1);
            }
            other => panic!("expected success, got {other:?}"),
        }
    }

    #[test]
    fn error_reply_maps_to_error_with_code() {
        let r = guest_reply_to_result(json!({
            "kind": "error",
            "message": "bad input",
            "code": "BAD_INPUT"
        }));
        match r {
            ToolExecutionResult::Error { message, code, .. } => {
                assert_eq!(message, "bad input");
                assert_eq!(code, "BAD_INPUT");
            }
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn unknown_reply_kind_is_an_error_not_a_panic() {
        let r = guest_reply_to_result(json!({ "kind": "weird" }));
        assert!(r.is_error());
    }

    #[test]
    fn missing_code_falls_back_to_plugin_error() {
        let r = guest_reply_to_result(json!({ "kind": "error", "message": "x" }));
        match r {
            ToolExecutionResult::Error { code, .. } => assert_eq!(code, "PLUGIN_ERROR"),
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn success_reply_without_content_defaults_to_ok() {
        let r = guest_reply_to_result(json!({ "kind": "success" }));
        match r {
            ToolExecutionResult::Success { content, .. } => {
                let text: String = content.iter().filter_map(|b| b.as_text()).collect();
                assert_eq!(text, "ok");
                let _ = ContentBlock::text("");
            }
            other => panic!("expected success, got {other:?}"),
        }
    }
}
