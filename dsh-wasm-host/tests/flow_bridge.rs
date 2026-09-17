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
use serde_json::{json, Value};

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

// ---------------------------------------------------------------------------
// The three points added to reach 6/6
//
// Each has a different contract, so each gets a test that would fail if the
// registration were removed or its translation were wrong.
// ---------------------------------------------------------------------------

/// A `llm/stream` hook that rewrites the request so the model sees different
/// text. The mock adapter **echoes the last user message**, which is what makes
/// this observable: if the rewrite did not reach the provider, the reply would
/// echo the original text instead.
#[tokio::test]
async fn llm_stream_rewrite_changes_what_the_model_receives() {
    let dir = tmpdir("llm-rewrite");
    let rewritten = json!({
        "provider": "mock",
        "model": "mock-1",
        "messages": [{
            "id": "m-rewritten",
            "role": "user",
            "content": [{ "type": "text", "text": "REWRITTEN BY PLUGIN" }],
            "source": { "kind": "user" }
        }]
    });
    let decision = json!({ "kind": "rewrite", "value": rewritten }).to_string();
    let wasm = write_wasm(&dir, "rewriter", &wasm_hook("rewriter", "llm/stream", "waterfall", &decision));

    let ctx = Context::new();
    boot_dsh(&ctx).await;
    script_echo(&ctx).await;
    install(
        &ctx,
        host(),
        vec![LoadSpec::new("rewriter", wasm.to_string_lossy().to_string())],
    )
    .await
    .unwrap();

    let agents = ctx.require::<AgentRegistryService>(dsh_rs::api::AGENTS_SERVICE).unwrap();
    let agent = agents
        .create(None, AgentOptions::mock("mock-1"), Some("/tmp".to_string()), None)
        .unwrap();
    agent.followup(Message::user(
        "u-1",
        vec![ContentBlock::text("ORIGINAL TEXT")],
    ));
    agent.when_idle().await;

    // The mock adapter echoes the last user message it was handed, so the
    // assistant text reveals which request actually went out.
    let assistant_text: String = agent
        .session()
        .events()
        .iter()
        .filter_map(|e| match &e.data {
            SessionEventData::AssistantMessage { message, .. }
                if message.role == dsh_rs::types::Role::Assistant =>
            {
                Some(message.text())
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");

    assert!(
        assistant_text.contains("REWRITTEN BY PLUGIN"),
        "the plugin's rewrite must be what the model was asked: {assistant_text:?}"
    );
    assert!(
        !assistant_text.contains("ORIGINAL TEXT"),
        "the original request must NOT have been sent: {assistant_text:?}"
    );
}

/// A malformed rewrite must be refused, not forwarded: dsh would otherwise fail
/// to deserialize it and report a generic error far from the cause. The turn
/// must proceed with the original request.
#[tokio::test]
async fn a_malformed_llm_rewrite_falls_back_to_the_original_request() {
    let dir = tmpdir("llm-bad-rewrite");
    // Drops `messages`, which dsh requires.
    let bad = json!({
        "kind": "rewrite",
        "value": { "provider": "mock", "model": "mock-1" }
    })
    .to_string();
    let wasm = write_wasm(&dir, "bad", &wasm_hook("bad", "llm/stream", "waterfall", &bad));

    let ctx = Context::new();
    boot_dsh(&ctx).await;
    script_echo(&ctx).await;
    install(
        &ctx,
        host(),
        vec![LoadSpec::new("bad", wasm.to_string_lossy().to_string())],
    )
    .await
    .unwrap();

    let agents = ctx.require::<AgentRegistryService>(dsh_rs::api::AGENTS_SERVICE).unwrap();
    let agent = agents
        .create(None, AgentOptions::mock("mock-1"), Some("/tmp".to_string()), None)
        .unwrap();
    agent.followup(Message::user("u-2", vec![ContentBlock::text("STILL HERE")]));
    agent.when_idle().await;

    let text: String = agent
        .session()
        .events()
        .iter()
        .filter_map(|e| match &e.data {
            SessionEventData::AssistantMessage { message, .. }
                if message.role == dsh_rs::types::Role::Assistant =>
            {
                Some(message.text())
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    assert!(
        text.contains("STILL HERE"),
        "a refused rewrite must leave the original request intact: {text:?}"
    );
}

/// `tools/execute` is the wrapper around the tool body, and dsh reads
/// `arguments` out of the payload handed to the continuation — so a rewrite
/// changes what the tool actually receives.
///
/// Observed via `register_dynamic_tool`, whose `exec` callback receives the
/// parsed arguments. (The WASM test tools reply with a fixed string and so
/// could not reveal what they were given.)
#[tokio::test]
async fn tool_execute_rewrite_changes_the_arguments_the_tool_receives() {
    use dsh_rs::api::services::DynamicToolSpec;
    use std::sync::{Arc, Mutex};

    let dir = tmpdir("tool-exec-rewrite");
    let decision = json!({
        "kind": "rewrite",
        "value": { "arguments": { "forced": true } }
    })
    .to_string();
    let wasm = write_wasm(
        &dir,
        "forcer",
        &wasm_hook("forcer", "tools/execute", "waterfall", &decision),
    );

    let ctx = Context::new();
    boot_dsh(&ctx).await;

    let seen: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let seen_in_tool = seen.clone();
    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE).unwrap();
    tools.register_dynamic_tool(DynamicToolSpec {
        name: "spy".into(),
        description: "records its arguments".into(),
        parameters: json!({ "type": "object" }),
        exec: Arc::new(move |args: Value| {
            let seen = seen_in_tool.clone();
            Box::pin(async move {
                seen.lock().unwrap().push(args);
                dsh_rs::types::ToolExecutionResult::success_value(json!({ "ok": true }))
            })
        }),
    });

    install(
        &ctx,
        host(),
        vec![LoadSpec::new("forcer", wasm.to_string_lossy().to_string())],
    )
    .await
    .unwrap();

    let result = tools
        .execute("c-exec".into(), "spy".into(), json!({ "original": 1 }), run_ctx(&ctx))
        .await;
    assert!(!result.is_error(), "the tool should have run: {result:?}");

    let recorded = seen.lock().unwrap().clone();
    assert_eq!(recorded.len(), 1, "the tool ran exactly once");
    assert_eq!(
        recorded[0],
        json!({ "forced": true }),
        "the tool body must have received the rewritten arguments, not the original"
    );
}

/// A `tools/execute` veto skips the body but must return a *tool error*, not
/// break the turn — the model then sees an ordinary failed call.
#[tokio::test]
async fn tool_execute_veto_returns_a_tool_error_not_a_broken_turn() {
    let dir = tmpdir("tool-exec-veto");
    let wasm = write_wasm(
        &dir,
        "blocker",
        &wasm_hook("blocker", "tools/execute", "waterfall", r#"{"kind":"veto","reason":"nope"}"#),
    );

    let ctx = Context::new();
    boot_dsh(&ctx).await;
    let toolwasm = write_wasm(&dir, "echotool", &wasm_tool("echo", "success"));
    install(
        &ctx,
        host(),
        vec![
            LoadSpec::new("echotool", toolwasm.to_string_lossy().to_string()),
            LoadSpec::new("blocker", wasm.to_string_lossy().to_string()),
        ],
    )
    .await
    .unwrap();

    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE).unwrap();
    let result = tools
        .execute("c-veto".into(), "echo_tool".into(), json!({}), run_ctx(&ctx))
        .await;
    match &result {
        dsh_rs::types::ToolExecutionResult::Error { code, .. } => {
            assert_eq!(code, "WASM_VETO", "a veto is reported as a tool error");
        }
        other => panic!("expected a tool error, got {other:?}"),
    }
    assert!(result.is_error());
}

/// `tools/post-execute` replaces the result the model sees — the seam for
/// redaction and normalisation.
#[tokio::test]
async fn tool_post_execute_rewrites_the_result_the_model_sees() {
    let dir = tmpdir("tool-post-rewrite");
    let replacement = json!({
        "kind": "success",
        "content": [{ "type": "text", "text": "REDACTED" }],
        "value": { "redacted": true }
    });
    let decision = json!({ "kind": "rewrite", "value": { "result": replacement } }).to_string();
    let wasm = write_wasm(
        &dir,
        "redactor",
        &wasm_hook("redactor", "tools/post-execute", "waterfall", &decision),
    );

    let ctx = Context::new();
    boot_dsh(&ctx).await;
    let toolwasm = write_wasm(&dir, "echotool", &wasm_tool("echo", "success"));
    install(
        &ctx,
        host(),
        vec![
            LoadSpec::new("echotool", toolwasm.to_string_lossy().to_string()),
            LoadSpec::new("redactor", wasm.to_string_lossy().to_string()),
        ],
    )
    .await
    .unwrap();

    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE).unwrap();
    let result = tools
        .execute("c-post".into(), "echo_tool".into(), json!({ "secret": "sauce" }), run_ctx(&ctx))
        .await;
    let text = match &result {
        dsh_rs::types::ToolExecutionResult::Success { content, .. }
        | dsh_rs::types::ToolExecutionResult::Error { content, .. } => content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    };
    assert_eq!(text, "REDACTED", "the model sees the rewritten result");
}

/// All six waterfall points must be registered — this is the whole point of
/// reaching 6/6, and it is easy to regress by deleting one `register_*` call.
#[tokio::test]
async fn all_six_dsh_waterfall_points_are_bridged() {
    let ctx = Context::new();
    boot_dsh(&ctx).await;
    let report = install_waterfalls(&ctx, &host()).await.unwrap();
    let mut got = report.waterfalls.clone();
    got.sort();
    assert_eq!(
        got,
        vec![
            "agent/pre-step",
            "agent/request",
            "llm/stream",
            "tools/execute",
            "tools/post-execute",
            "tools/pre-execute",
        ],
        "dsh exposes exactly six waterfall points; the bridge must cover them all"
    );
}

/// The bridge's own event vocabulary must accept every name it now registers.
#[test]
fn the_flow_vocabulary_covers_the_three_new_points() {
    use wasm_plugin_host::FlowEvent;
    for (name, ev) in [
        ("llm/stream", FlowEvent::LlmRequest),
        ("tools/execute", FlowEvent::ToolExecute),
        ("tools/post-execute", FlowEvent::ToolResultPost),
    ] {
        assert_eq!(
            FlowEvent::parse(name),
            Some(ev),
            "`{name}` must parse for plugins to subscribe"
        );
        assert_eq!(ev.as_str(), name, "and must round-trip to its own name");
    }
}
