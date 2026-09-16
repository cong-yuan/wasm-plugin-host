//! Flow bridge: wire dsh's intervention points to the WASM hook bus.
//!
//! dsh and `wasm-plugin-host` share an event vocabulary but not an *envelope*:
//!
//! | | dsh (cordis) | wasm-plugin-host |
//! |---|---|---|
//! | dispatch | `ctx.waterfall(name, payload, fallback)` | `Registry::dispatch(Event, value)` |
//! | listener | `Fn(Context, Value, Next)` | a guest `plugin_invoke(op, …)` |
//! | decision | per-point shape (`{kind:"allow"}`, `{kind:"enter"}`) | `{kind:"continue"\|"rewrite"\|"veto"}` |
//!
//! ## How a guest decision is recovered
//!
//! `Registry::dispatch` runs every subscribed guest hook and **applies** their
//! waterfall decisions internally: it returns the *final payload* plus a
//! `vetoed_by` marker — not a `Decision`. So this bridge recovers the intent
//! from two signals:
//!
//! * `dispatch.vetoed_by.is_some()` → a guest vetoed;
//! * `dispatch.value != original` → a guest (or a chain of them) rewrote;
//!
//! and otherwise treats it as `continue`. That is exact: a "rewrite to an
//! identical value" is indistinguishable from `continue`, and *behaviourally
//! identical*, so nothing is lost.
//!
//! ## What maps to what
//!
//! | dsh point | guest `veto` | guest `rewrite` |
//! |---|---|---|
//! | `tools/pre-execute` | → `{kind:"deny"}` | ignored (dsh accepts only allow/deny/ask here; argument rewriting belongs at `tools/execute`, which is not bridged) |
//! | `agent/pre-step` | → `{kind:"reject"}` | → `{kind:"enter", messages}` |
//! | `agent/request` | ignored (no reject vocabulary) | → the replacement `LlmCallConfig` |
//! | `session/event` | — | — (observe only) |
//!
//! ## One vocabulary, one rename no more
//!
//! `wasm-plugin-host`'s `Event::LlmChunk` now serializes as
//! `assistant/chunk`, matching dsh's `SessionEventData::event_type()`
//! exactly, so the fan-out is a direct name match. (`llm/chunk` was the old
//! name and is still accepted as a legacy alias by the guest-side parser.)

use anyhow::Result;
use cordis::{Context, Next};
use serde_json::{json, Value};

use wasm_plugin_host::{Dispatch, FlowEvent};

use crate::host::WasmHost;

/// What the flow bridge registered, for logging and tests.
#[derive(Debug, Clone, Default)]
pub struct FlowBridgeReport {
    /// dsh waterfall points where a guest may veto or rewrite.
    pub waterfalls: Vec<&'static str>,
    /// dsh events fanned out to guest `observe` hooks.
    pub observe: Vec<&'static str>,
}

/// Install the full bridge: the intervention waterfalls **and** the read-only
/// `session/event` fan-out.
pub async fn install_flow_bridge(ctx: &Context, host: &WasmHost) -> Result<FlowBridgeReport> {
    let mut report = install_waterfalls(ctx, host).await?;
    report.observe = install_observe(ctx, host).await?;
    Ok(report)
}

/// Install only the intervention waterfalls (guest may veto/rewrite).
pub async fn install_waterfalls(ctx: &Context, host: &WasmHost) -> Result<FlowBridgeReport> {
    register_pre_execute(ctx, host.clone()).await?;
    register_pre_step(ctx, host.clone()).await?;
    register_request(ctx, host.clone()).await?;
    Ok(FlowBridgeReport {
        waterfalls: vec!["tools/pre-execute", "agent/pre-step", "agent/request"],
        observe: Vec::new(),
    })
}

/// Install only the read-only `session/event` observe fan-out.
pub async fn install_observe(ctx: &Context, host: &WasmHost) -> Result<Vec<&'static str>> {
    let host = host.clone();
    ctx.on(
        "session/event",
        move |_ctx: Context, payload: Value, next: Next| {
            let host = host.clone();
            Box::pin(async move {
                if let Some(ev) = session_event_to_flow(&payload) {
                    let inner = payload.get("event").cloned().unwrap_or(Value::Null);
                    // Observe hooks cannot change the flow; the dispatch is
                    // purely so guests can see the event. Guarded so a
                    // misbehaving guest can never break the session firehose.
                    if let Ok(mut reg) = host.registry().lock() {
                        let _ = reg.dispatch(ev, inner);
                    }
                }
                // Observe must never affect the session log.
                next.run(payload).await
            })
        },
    )
    .await
    .map_err(|e| anyhow::anyhow!("registering session/event observe listener: {e}"))?;
    Ok(vec!["session/event"])
}

// ---------------------------------------------------------------------------
// Waterfall points
// ---------------------------------------------------------------------------

/// `tools/pre-execute` — the allow/deny gate in front of every tool call.
///
/// dsh's contract: the waterfall must *return* `{kind:"allow"|"deny"|"ask"}`.
/// A guest `veto` becomes `deny`; `continue`/`rewrite` fall through to dsh's
/// own `allow`.
async fn register_pre_execute(ctx: &Context, host: WasmHost) -> Result<()> {
    ctx.on(
        "tools/pre-execute",
        move |_ctx: Context, payload: Value, next: Next| {
            let host = host.clone();
            Box::pin(async move {
                let dispatch = run_guest(&host, FlowEvent::ToolsPreExecute, &payload);
                if dispatch.vetoed_by.is_some() {
                    return Ok(json!({ "kind": "deny", "reason": veto_reason(&dispatch) }));
                }
                // continue / rewrite both fall through to dsh's own allow.
                // (dsh's pre-execute decision cannot carry new arguments.)
                next.run(payload).await
            })
        },
    )
    .await
    .map_err(err("tools/pre-execute"))?;
    Ok(())
}

/// `agent/pre-step` — the message batch entering a turn.
///
/// dsh's fallback ignores its input and returns the *captured* original
/// messages, so a guest rewrite cannot be expressed by forwarding a new
/// payload. We therefore build the decision ourselves.
async fn register_pre_step(ctx: &Context, host: WasmHost) -> Result<()> {
    ctx.on(
        "agent/pre-step",
        move |_ctx: Context, payload: Value, next: Next| {
            let host = host.clone();
            Box::pin(async move {
                let dispatch = run_guest(&host, FlowEvent::AgentPreStep, &payload);
                if dispatch.vetoed_by.is_some() {
                    return Ok(json!({ "kind": "reject", "reason": veto_reason(&dispatch) }));
                }
                match rewritten_payload(&dispatch, &payload) {
                    Some(value) => {
                        let messages = extract_messages(&value)
                            .or_else(|| payload.get("messages").cloned())
                            .unwrap_or(json!([]));
                        Ok(json!({ "kind": "enter", "messages": messages }))
                    }
                    // No rewrite: defer to dsh's fallback (enter, original batch).
                    None => next.run(payload).await,
                }
            })
        },
    )
    .await
    .map_err(err("agent/pre-step"))?;
    Ok(())
}

/// `agent/request` — resolve the `LlmCallConfig` for a turn.
///
/// dsh's fallback produces the default config; a guest `rewrite` replaces it.
async fn register_request(ctx: &Context, host: WasmHost) -> Result<()> {
    ctx.on(
        "agent/request",
        move |_ctx: Context, payload: Value, next: Next| {
            let host = host.clone();
            Box::pin(async move {
                let dispatch = run_guest(&host, FlowEvent::AgentRequest, &payload);
                // This point has no "reject" vocabulary; a rewrite replaces the
                // resolved config, anything else defers to dsh's default.
                if let Some(value) = rewritten_payload(&dispatch, &payload) {
                    return Ok(value);
                }
                next.run(payload).await
            })
        },
    )
    .await
    .map_err(err("agent/request"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/// Run the guest hook chain for one event, dropping the registry lock before
/// returning so the caller can safely touch dsh's `Next`.
fn run_guest(host: &WasmHost, ev: FlowEvent, payload: &Value) -> Dispatch {
    // A guest panic poisons the mutex; recover the guard rather than wedge the
    // whole host, matching the runtime's fail-open hook policy.
    let registry = host.registry();
    let mut reg = match registry.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    reg.dispatch(ev, payload.clone())
}

/// The value a guest rewrote the payload to, or `None` if the payload is
/// unchanged (i.e. the chain only continued).
fn rewritten_payload(dispatch: &Dispatch, original: &Value) -> Option<Value> {
    if &dispatch.value == original {
        None
    } else {
        Some(dispatch.value.clone())
    }
}

/// Pull a message array out of a rewritten `agent/pre-step` value, accepting
/// either the full payload (`{"messages":[…]}`) or the array directly.
fn extract_messages(value: &Value) -> Option<Value> {
    match value {
        Value::Array(_) => Some(value.clone()),
        Value::Object(_) => value.get("messages").cloned(),
        _ => None,
    }
}

fn err(name: &'static str) -> impl Fn(cordis::Error) -> anyhow::Error {
    move |e| anyhow::anyhow!("registering flow listener `{name}`: {e}")
}

/// Map a dsh `session/event` payload onto a WASM flow event, if we bridge it.
fn session_event_to_flow(payload: &Value) -> Option<FlowEvent> {
    let kind = payload.get("event")?.get("type")?.as_str()?;
    Some(match kind {
        "turn/start" => FlowEvent::TurnStart,
        "turn/end" => FlowEvent::TurnEnd,
        // dsh's chunk event and our vocabulary now agree on the name.
        "assistant/chunk" => FlowEvent::LlmChunk,
        "assistant/message" => FlowEvent::AssistantMessage,
        "tool/call" => FlowEvent::ToolCall,
        "tool/result" => FlowEvent::ToolResult,
        _ => return None,
    })
}

/// The reason attached to a dsh decision when a guest vetoed.
///
/// The specific reason a guest supplied is **not recoverable here**: the
/// host's `Registry::dispatch` breaks out of the subscriber loop on a veto
/// without copying the guest's reply into the returned [`Dispatch`], which
/// carries only `vetoed_by`. Propagating the real reason would need an
/// additive field on the host's `Dispatch` (see docs/已知问题.md); until then
/// we report a stable, generic denial so downstream logs are honest rather
/// than fabricated.
fn veto_reason(_dispatch: &Dispatch) -> String {
    "denied by wasm plugin".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dispatch(value: Value, vetoed: bool) -> Dispatch {
        Dispatch {
            value,
            vetoed_by: vetoed.then(|| "slot".to_string()),
            ran: 1,
            errored: Vec::new(),
        }
    }

    #[test]
    fn veto_reason_is_generic_because_the_host_drops_it() {
        // Even when the guest's reply carried a reason, `Dispatch` does not
        // preserve it — so the bridge reports a stable fallback.
        let d = dispatch(json!({ "reason": "nope" }), true);
        assert_eq!(veto_reason(&d), "denied by wasm plugin");
    }

    #[test]
    fn unchanged_payload_is_not_a_rewrite() {
        let p = json!({ "a": 1 });
        assert_eq!(rewritten_payload(&dispatch(p.clone(), false), &p), None);
    }

    #[test]
    fn differing_payload_is_a_rewrite() {
        let original = json!({ "a": 1 });
        let rewritten = json!({ "a": 2 });
        assert_eq!(
            rewritten_payload(&dispatch(rewritten.clone(), false), &original),
            Some(rewritten)
        );
    }

    #[test]
    fn extract_messages_accepts_payload_or_array() {
        let payload = json!({ "messages": [1, 2] });
        assert_eq!(extract_messages(&payload), Some(json!([1, 2])));
        let array = json!([1, 2]);
        assert_eq!(extract_messages(&array), Some(json!([1, 2])));
        assert_eq!(extract_messages(&json!("nope")), None);
    }

    #[test]
    fn session_firehose_maps_bridged_types() {
        let map = |t: &str| session_event_to_flow(&json!({ "event": { "type": t } }));
        assert_eq!(map("turn/start"), Some(FlowEvent::TurnStart));
        assert_eq!(map("turn/end"), Some(FlowEvent::TurnEnd));
        assert_eq!(map("assistant/chunk"), Some(FlowEvent::LlmChunk));
        assert_eq!(map("assistant/message"), Some(FlowEvent::AssistantMessage));
        assert_eq!(map("tool/call"), Some(FlowEvent::ToolCall));
        assert_eq!(map("tool/result"), Some(FlowEvent::ToolResult));
    }

    #[test]
    fn session_firehose_ignores_unbridged_types() {
        let map = |t: &str| session_event_to_flow(&json!({ "event": { "type": t } }));
        assert_eq!(map("user/message"), None);
        assert_eq!(map("step/start"), None);
        assert_eq!(map("nonsense"), None);
    }

    #[test]
    fn malformed_firehose_payload_is_ignored() {
        assert_eq!(session_event_to_flow(&json!({})), None);
        assert_eq!(session_event_to_flow(&json!({ "event": {} })), None);
        assert_eq!(session_event_to_flow(&json!(null)), None);
    }
}
