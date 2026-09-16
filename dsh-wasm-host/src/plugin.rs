//! A cordis [`Plugin`] that mounts WASM plugins into a dsh harness.
//!
//! The plugin body does three things, all as fiber effects so unloading the
//! fiber tears everything down in reverse order:
//!
//! 1. registers every tool the loaded WASM plugins declare on dsh's
//!    `ctx.tools`, as a *dynamic tool* whose `exec` calls back into the guest;
//! 2. installs the flow bridge (see [`crate::bridge`]);
//! 3. registers a disposer that unregisters those same tools.
//!
//! Because it declares `inject: ["tools"]`, the fiber stays PENDING until
//! dsh's tool registry is live — the same dependency discipline every dsh
//! plugin follows.

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

/// The cordis plugin that bridges a [`WasmHost`] into a dsh context.
pub struct WasmHostPlugin {
    host: WasmHost,
}

impl WasmHostPlugin {
    pub fn new(host: WasmHost) -> Self {
        Self { host }
    }

    /// The host this plugin drives.
    pub fn host(&self) -> &WasmHost {
        &self.host
    }
}

impl std::fmt::Debug for WasmHostPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WasmHostPlugin")
            .field("host", &self.host)
            .finish()
    }
}

impl Plugin for WasmHostPlugin {
    fn name(&self) -> std::borrow::Cow<'static, str> {
        std::borrow::Cow::Borrowed("wasm-plugin-host")
    }

    fn inject(&self) -> Vec<Injection> {
        // The tool registry must exist before we can register into it.
        vec![Injection::new(TOOLS_SERVICE)]
    }

    fn apply(&self, ctx: Context, _config: Value) -> BoxFuture<cordis::Result<()>> {
        let host = self.host.clone();
        Box::pin(async move {
            let tools = ctx
                .require::<ToolsService>(TOOLS_SERVICE)
                .map_err(|e| cordis::Error::msg(format!("tools service missing: {e}")))?;

            // 1. Register every declared tool as a dsh dynamic tool.
            let registered = register_all_tools(&tools, &host);

            // 2. Install the flow bridge (waterfalls + observe fan-out).
            bridge::install_flow_bridge(&ctx, &host)
                .await
                .map_err(|e| cordis::Error::msg(format!("flow bridge: {e}")))?;

            // 3. Unregister those tools when the fiber unloads.
            let tools_for_dispose = tools.clone();
            ctx.effect("wasm plugin tools", async move {
                let disposer: cordis::Disposer = Box::new(move || {
                    Box::pin(async move {
                        for name in registered {
                            tools_for_dispose.unregister_dynamic_tool(&name);
                        }
                    })
                });
                Ok(Some(disposer))
            })
            .await?;

            ctx.logger().log_event(
                cordis::LogLevel::Info,
                "wasm-plugin-host".to_string(),
                None,
                format!(
                    "{} wasm plugin(s) bridged",
                    host.list_plugins().len()
                ),
            );
            Ok(())
        })
    }
}

/// Register every tool the host currently exposes; returns their names.
fn register_all_tools(tools: &ToolsService, host: &WasmHost) -> Vec<String> {
    let mut names = Vec::new();
    for info in host.list_tools() {
        register_one(tools, host, &info);
        names.push(info.name);
    }
    names
}

/// Register a single WASM tool as a dsh dynamic tool.
///
/// The `exec` closure runs the guest call on the blocking pool (wasmtime calls
/// are synchronous) and maps the guest's reply onto a
/// [`ToolExecutionResult`].
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
                    Ok(Err(e)) => {
                        ToolExecutionResult::error("WASM_CALL", e.to_string())
                    }
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

/// Load `specs` into `host`, then mount the host into `ctx` as a plugin.
///
/// Returns the fiber handle, which the caller joins (or disposes) as usual.
/// Plugins are loaded *before* the fiber starts so the tool registration in
/// `apply` sees them.
pub async fn install(
    ctx: &Context,
    host: WasmHost,
    specs: Vec<LoadSpec>,
) -> anyhow::Result<FiberHandle> {
    for spec in &specs {
        host.load(&spec.slot, &spec.path, spec.config.clone())
            .map_err(|e| anyhow::anyhow!("loading `{}` for slot `{}`: {e}", spec.path, spec.slot))?;
    }
    let plugin: Arc<dyn Plugin> = Arc::new(WasmHostPlugin::new(host));
    let fiber = ctx.plugin(plugin, None);
    fiber
        .join()
        .await
        .map_err(|e| anyhow::anyhow!("wasm host fiber failed to converge: {e}"))?;
    Ok(fiber)
}

/// Re-synchronise dsh's tool registry with the host's current tool set.
///
/// Call this after a hot [`WasmHost::reload`] so newly-declared tools appear
/// and removed ones disappear. Returns `(added, removed)`.
pub fn resync_tools(tools: &ToolsService, host: &WasmHost, tracked: &mut Vec<String>) -> (Vec<String>, Vec<String>) {
    let current: Vec<WasmToolInfo> = host.list_tools();
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
                let _ = ContentBlock::text(""); // exercise the re-export
            }
            other => panic!("expected success, got {other:?}"),
        }
    }
}
