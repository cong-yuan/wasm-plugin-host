//! End-to-end: a WASM plugin's tool runs inside dsh's real agent loop.
//!
//! This is the headline claim of `dsh-wasm-host` — a `.wasm` plugin is not a
//! callable leaf bolted on the side; it is registered on `ctx.tools` and
//! driven by dsh's own arm. The model (scripted mock adapter) asks for the
//! tool, the agent loop dispatches it, and the guest answers.

mod common;

use dsh_rs::api::services::{AgentRegistryService, LlmService, ToolsService};
use dsh_rs::types::{AgentOptions, ContentBlock, Message, SessionEventData};
use dsh_wasm_host::{install, LoadSpec};
use serde_json::json;

use common::{boot_dsh, host, tmpdir, wasm_tool, write_wasm};

/// Boot dsh, load a wasm tool, and script the model to call it once.
async fn harness(tag: &str, slot: &str) -> (cordis::Context, dsh_wasm_host::WasmHost, std::path::PathBuf) {
    let dir = tmpdir(tag);
    let wasm = write_wasm(&dir, slot, &wasm_tool(slot, "success"));
    let ctx = cordis::Context::new();
    boot_dsh(&ctx).await;
    let host = host();
    install(
        &ctx,
        host.clone(),
        vec![LoadSpec::new(slot, wasm.to_string_lossy().to_string())],
    )
    .await
    .expect("install succeeds");
    (ctx, host, dir)
}

#[tokio::test]
async fn wasm_tool_is_registered_on_dsh_tools_service() {
    let (ctx, _host, _dir) = harness("registered", "alpha").await;
    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE).unwrap();
    assert!(
        tools.list().contains(&"alpha_tool".to_string()),
        "wasm tool must appear on ctx.tools, got {:?}",
        tools.list()
    );
}

#[tokio::test]
async fn agent_loop_drives_a_wasm_tool_and_logs_its_result() {
    let (ctx, _host, _dir) = harness("agent-loop", "alpha").await;

    // Script the mock provider: call the wasm tool, then finish.
    let runtime = ctx.require::<LlmService>(dsh_rs::api::LLM_SERVICE).unwrap();
    runtime.unregister_adapter(&["mock"]);
    runtime
        .register_adapter(
            &["mock"],
            std::sync::Arc::new(dsh_rs::llm::adapters::mock::MockAdapter::scripted(vec![
                dsh_rs::llm::adapters::mock::MockAdapter::tool_call_response(
                    "call-1",
                    "alpha_tool",
                    json!({}),
                ),
                dsh_rs::llm::adapters::mock::MockAdapter::text_response("done"),
            ])),
        )
        .unwrap();

    let agents = ctx.require::<AgentRegistryService>(dsh_rs::api::AGENTS_SERVICE).unwrap();
    let agent = agents
        .create(None, AgentOptions::mock("mock-1"), Some("/tmp".to_string()), None)
        .unwrap();
    agent.followup(Message::user(
        "u-1",
        vec![ContentBlock::text("use the wasm tool")],
    ));
    agent.when_idle().await;

    // The guest's result must be logged as a ToolResult on the session.
    let events = agent.session().events();
    let results: Vec<String> = events
        .iter()
        .filter_map(|e| match &e.data {
            SessionEventData::ToolResult { message, .. } => Some(tool_result_text(message)),
            _ => None,
        })
        .collect();
    assert_eq!(results.len(), 1, "exactly one tool result, got {results:?}");
    assert!(
        results[0].contains("alpha ran"),
        "guest content must reach the model, got {:?}",
        results[0]
    );

    // And the model's follow-up text closed the turn.
    let messages = agent.session().derive_messages();
    assert_eq!(messages.last().unwrap().text(), "done");
}

#[tokio::test]
async fn calling_an_unknown_wasm_tool_is_a_structured_error() {
    let (ctx, _host, _dir) = harness("unknown-tool", "alpha").await;
    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE).unwrap();
    let result = tools
        .execute(
            "call-x".into(),
            "no_such_tool".into(),
            json!({}),
            run_ctx(&ctx),
        )
        .await;
    assert!(result.is_error(), "unknown tool must error, got {result:?}");
}

#[tokio::test]
async fn wasm_tool_removed_when_host_fiber_is_disposed() {
    let dir = tmpdir("dispose");
    let wasm = write_wasm(&dir, "alpha", &wasm_tool("alpha", "success"));
    let ctx = cordis::Context::new();
    boot_dsh(&ctx).await;
    let host = host();
    let fiber = install(
        &ctx,
        host.clone(),
        vec![LoadSpec::new("alpha", wasm.to_string_lossy().to_string())],
    )
    .await
    .unwrap();

    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE).unwrap();
    assert!(tools.list().contains(&"alpha_tool".to_string()));

    fiber.dispose().await;
    assert!(
        !tools.list().contains(&"alpha_tool".to_string()),
        "unloading the host fiber must unregister its tools"
    );
}

#[tokio::test]
async fn two_wasm_plugins_register_distinct_tools() {
    let dir = tmpdir("two");
    let a = write_wasm(&dir, "a", &wasm_tool("a", "success"));
    let b = write_wasm(&dir, "b", &wasm_tool("b", "success"));
    let ctx = cordis::Context::new();
    boot_dsh(&ctx).await;
    let host = host();
    install(
        &ctx,
        host.clone(),
        vec![
            LoadSpec::new("a", a.to_string_lossy().to_string()),
            LoadSpec::new("b", b.to_string_lossy().to_string()),
        ],
    )
    .await
    .unwrap();

    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE).unwrap();
    let names = tools.list();
    assert!(names.contains(&"a_tool".to_string()), "got {names:?}");
    assert!(names.contains(&"b_tool".to_string()), "got {names:?}");
}

#[tokio::test]
async fn unload_after_install_still_leaves_host_consistent() {
    // Loading then unloading a slot while the fiber stays up must remove the
    // tool from the host; the fiber's own resync is explicit (see resync_tools).
    let dir = tmpdir("unload-live");
    let wasm = write_wasm(&dir, "alpha", &wasm_tool("alpha", "success"));
    let ctx = cordis::Context::new();
    boot_dsh(&ctx).await;
    let host = host();
    install(
        &ctx,
        host.clone(),
        vec![LoadSpec::new("alpha", wasm.to_string_lossy().to_string())],
    )
    .await
    .unwrap();

    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE).unwrap();
    let mut tracked = vec!["alpha_tool".to_string()];

    host.unload("alpha").unwrap();
    let (added, removed) =
        dsh_wasm_host::plugin::resync_tools(&tools, &host, &mut tracked);
    assert_eq!(removed, vec!["alpha_tool".to_string()]);
    assert!(added.is_empty());
    assert!(!tools.list().contains(&"alpha_tool".to_string()));
}

/// A `ToolRunContext` for direct `execute` calls in tests.
fn run_ctx(ctx: &cordis::Context) -> dsh_rs::types::ToolRunContext {
    dsh_rs::types::ToolRunContext {
        ctx: ctx.clone(),
        signal: dsh_rs::types::CancelToken::new(),
        agent_id: Some("agent-test".to_string()),
        cwd: Some("/tmp".to_string()),
    }
}

/// Extract text from a tool-result message's nested blocks.
fn tool_result_text(message: &Message) -> String {
    let mut out = String::new();
    for block in &message.content {
        if let ContentBlock::ToolResult { content, .. } = block {
            for inner in content {
                if let ContentBlock::Text { text } = inner {
                    out.push_str(text);
                }
            }
        }
    }
    out
}
