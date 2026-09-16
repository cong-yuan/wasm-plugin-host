//! Flow-bridge tests: a WASM plugin intervening in dsh's own flow, end to end.
//!
//! These exercise the three waterfall points and the read-only `session/event`
//! fan-out, asserting the decision translation each one performs.

mod common;

use cordis::Context;
use dsh_rs::api::services::{AgentRegistryService, ToolsService};
use dsh_rs::types::{AgentOptions, ContentBlock, Message, SessionEventData};
use dsh_wasm_host::bridge::{install_observe, install_waterfalls};
use dsh_wasm_host::{install, LoadSpec};
use serde_json::json;

use common::{boot_dsh, host, script_tool_call, tmpdir, wasm_hook, wasm_tool, wasm_tool_with_veto, write_wasm};

#[tokio::test]
async fn guest_veto_blocks_a_tool_call_through_the_real_agent_loop() {
    let dir = tmpdir("veto-tool");
    let wasm = write_wasm(&dir, "guard", &wasm_tool_with_veto("guard", "guarded_tool"));

    let ctx = Context::new();
    boot_dsh(&ctx).await;
    let host = host();
    install(
        &ctx,
        host.clone(),
        vec![LoadSpec::new("guard", wasm.to_string_lossy().to_string())],
    )
    .await
    .unwrap();

    // Direct dispatcher sanity: the guest veto really denies the call.
    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE).unwrap();
    let denied = tools
        .execute("c1".into(), "guarded_tool".into(), json!({}), run_ctx(&ctx))
        .await;
    assert!(denied.is_error(), "guest veto must deny the call: {denied:?}");
    match &denied {
        dsh_rs::types::ToolExecutionResult::Error { code, message, .. } => {
            assert_eq!(code, "DENIED", "pre-execute deny maps to DENIED");
            assert!(
                message.contains("wasm plugin"),
                "reason should be present: {message}"
            );
        }
        other => panic!("expected DENIED, got {other:?}"),
    }

    // And the same veto applies inside a real agent turn: the model asks for
    // the guarded tool and receives a DENIED tool result, not a success.
    script_tool_call(&ctx, "call-1", "guarded_tool", json!({})).await;
    let agents = ctx.require::<AgentRegistryService>(dsh_rs::api::AGENTS_SERVICE).unwrap();
    let agent = agents
        .create(None, AgentOptions::mock("mock-1"), Some("/tmp".to_string()), None)
        .unwrap();
    agent.followup(Message::user(
        "u-1",
        vec![ContentBlock::text("call the guarded tool")],
    ));
    agent.when_idle().await;

    let denied_in_loop = agent.session().events().iter().any(|e| {
        matches!(
            &e.data,
            SessionEventData::ToolResult { message, .. }
                if message.content.iter().any(|b| matches!(
                    b,
                    ContentBlock::ToolResult { is_error: Some(true), .. }
                ))
        )
    });
    assert!(
        denied_in_loop,
        "the guest veto must surface as an error tool result in the agent loop"
    );
}

#[tokio::test]
async fn guest_hook_can_run_without_a_tool_surface() {
    // A pure flow plugin (no tools) still bridges: it contributes a listener.
    let dir = tmpdir("pure-hook");
    let wasm = write_wasm(
        &dir,
        "watcher",
        &wasm_hook("watcher", "turn/start", "observe", r#"{"kind":"continue"}"#),
    );
    let ctx = Context::new();
    boot_dsh(&ctx).await;
    let host = host();
    install(
        &ctx,
        host.clone(),
        vec![LoadSpec::new("watcher", wasm.to_string_lossy().to_string())],
    )
    .await
    .unwrap();

    // No tools, but the plugin is loaded and has a hook subscription.
    assert!(host.list_tools().is_empty());
    let plugins = host.list_plugins();
    assert_eq!(plugins.len(), 1);
    assert_eq!(plugins[0].0, "watcher");
}

#[tokio::test]
async fn observe_fanout_does_not_alter_the_session_log() {
    // An observe hook that returns a bogus decision must not change anything.
    let dir = tmpdir("observe");
    let wasm = write_wasm(
        &dir,
        "noisy",
        &wasm_hook("noisy", "tools/pre-execute", "observe", r#"{"kind":"veto"}"#),
    );
    let toolwasm = write_wasm(&dir, "echo", &wasm_tool("echo", "success"));

    let ctx = Context::new();
    boot_dsh(&ctx).await;
    let host = host();
    install(
        &ctx,
        host.clone(),
        vec![
            LoadSpec::new("noisy", wasm.to_string_lossy().to_string()),
            LoadSpec::new("echo", toolwasm.to_string_lossy().to_string()),
        ],
    )
    .await
    .unwrap();

    // The observe-only hook cannot veto, so the tool still runs.
    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE).unwrap();
    let result = tools
        .execute("c1".into(), "echo_tool".into(), json!({}), run_ctx(&ctx))
        .await;
    assert!(!result.is_error(), "observe hook must not deny: {result:?}");
}

#[tokio::test]
async fn pre_step_veto_rejects_the_turn() {
    let dir = tmpdir("pre-step-veto");
    let wasm = write_wasm(
        &dir,
        "gate",
        &wasm_hook("gate", "agent/pre-step", "waterfall", r#"{"kind":"veto"}"#),
    );

    let ctx = Context::new();
    boot_dsh(&ctx).await;
    let host = host();
    host.load("gate", &wasm, json!(null)).unwrap();
    // Install the bridge after loading, so the listener wraps the subscription.
    install_waterfalls(&ctx, &host).await.unwrap();

    // Boot a scripted adapter so a turn can actually run.
    script_echo(&ctx).await;

    let agents = ctx.require::<AgentRegistryService>(dsh_rs::api::AGENTS_SERVICE).unwrap();
    let agent = agents
        .create(None, AgentOptions::mock("mock-1"), Some("/tmp".to_string()), None)
        .unwrap();
    agent.followup(Message::user("u-1", vec![ContentBlock::text("go")]));
    agent.when_idle().await;

    // The turn was rejected: it ends Blocked and the model never produced text.
    let events = agent.session().events();
    let saw_assistant = events
        .iter()
        .any(|e| matches!(e.data, SessionEventData::AssistantMessage { .. }));
    assert!(!saw_assistant, "a vetoed pre-step must not reach the model");
}

#[tokio::test]
async fn observe_listener_alone_mounts_and_continues() {
    let ctx = Context::new();
    boot_dsh(&ctx).await;
    let host = host();
    let report = install_observe(&ctx, &host).await.unwrap();
    assert_eq!(report, vec!["session/event"]);

    // A full turn with no guests must be a no-op for the bridge.
    script_echo(&ctx).await;
    let agents = ctx.require::<AgentRegistryService>(dsh_rs::api::AGENTS_SERVICE).unwrap();
    let agent = agents
        .create(None, AgentOptions::mock("mock-1"), Some("/tmp".to_string()), None)
        .unwrap();
    agent.followup(Message::user("u-1", vec![ContentBlock::text("hi")]));
    agent.when_idle().await;
    let messages = agent.session().derive_messages();
    assert_eq!(messages.last().unwrap().text(), "hi");
}

/// Swap in a mock adapter that echoes the last user message.
async fn script_echo(ctx: &Context) {
    common::script_echo(ctx).await;
}

fn run_ctx(ctx: &cordis::Context) -> dsh_rs::types::ToolRunContext {
    dsh_rs::types::ToolRunContext {
        ctx: ctx.clone(),
        signal: dsh_rs::types::CancelToken::new(),
        agent_id: Some("agent-test".to_string()),
        cwd: Some("/tmp".to_string()),
    }
}
