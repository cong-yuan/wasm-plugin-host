//! A minimal **agent flow** — the thing plugins intervene in.
//!
//! This is deliberately small: a turn is `pre-step → model → tool calls →
//! result`, with the dsh event names fired at each point. Plugins subscribed via
//! `hooks` in their declaration can observe or intervene at any of them.
//!
//! The point is not to be a full agent (no real LLM here). The point is to give
//! plugins a **flow to enter**: a place where `agent/pre-step` can veto, where
//! `tools/pre-execute` can rewrite arguments, where `assistant/chunk` can transform
//! streamed text. That is what "the plugin participates in dsh" means.
//!
//! A real host would replace [`Model::complete`] with an actual provider; the
//! event plumbing around it is what this module contributes.

use anyhow::Result;
use serde_json::{json, Value};

use crate::hooks::Event;
use crate::registry::Registry;

/// Pluggable "model" step. A real host implements this over an LLM; tests and
/// demos use a scripted one.
pub trait Model {
    /// Produce an assistant message for the given conversation.
    fn complete(&mut self, messages: &[Value]) -> Result<String>;
}

/// A scripted model: returns queued replies in order. Used for tests/demos.
#[derive(Default)]
pub struct ScriptedModel {
    replies: std::collections::VecDeque<String>,
}

impl ScriptedModel {
    pub fn new(replies: impl IntoIterator<Item = String>) -> Self {
        Self {
            replies: replies.into_iter().collect(),
        }
    }
}

impl Model for ScriptedModel {
    fn complete(&mut self, _messages: &[Value]) -> Result<String> {
        Ok(self.replies.pop_front().unwrap_or_else(|| "done".into()))
    }
}

/// Outcome of one turn.
#[derive(Debug)]
pub struct TurnOutcome {
    pub turn: u64,
    /// Assistant text after any `assistant/chunk` rewriting.
    pub reply: String,
    /// Tool calls that actually executed (name, rewritten args, result).
    pub executed: Vec<(String, Value, Value)>,
    /// Set if a hook vetoed the step.
    pub vetoed: Option<String>,
}

/// Run one turn: `turn/start → agent/pre-step → model → tools → turn/end`.
///
/// At every step the corresponding event is dispatched through `reg`, so any
/// subscribed plugin can observe or intervene.
pub fn run_turn(
    reg: &mut Registry,
    model: &mut dyn Model,
    turn: u64,
    user_input: &str,
) -> Result<TurnOutcome> {
    // --- turn/start (observe) ---
    let _ = reg.dispatch(Event::TurnStart, json!({ "turn": turn, "input": user_input }));

    // --- agent/pre-step (waterfall: may rewrite the input or veto the step) ---
    let pre = reg.dispatch(Event::AgentPreStep, json!({ "turn": turn, "input": user_input }));
    if let Some(by) = pre.vetoed_by {
        let _ = reg.dispatch(Event::TurnEnd, json!({ "turn": turn, "vetoed_by": by }));
        return Ok(TurnOutcome {
            turn,
            reply: String::new(),
            executed: Vec::new(),
            vetoed: Some(by),
        });
    }
    // A rewrite may replace the input (e.g. redaction, injection of context).
    let effective_input = pre
        .value
        .get("input")
        .and_then(|v| v.as_str())
        .unwrap_or(user_input)
        .to_string();

    // --- agent/request (waterfall: may rewrite the messages) ---
    let messages = vec![json!({ "role": "user", "content": effective_input })];
    let req = reg.dispatch(
        Event::AgentRequest,
        json!({ "turn": turn, "messages": messages.clone() }),
    );
    let messages = req
        .value
        .get("messages")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(messages));

    // --- model call ---
    let raw_reply = model.complete(messages.as_array().map(|a| a.as_slice()).unwrap_or(&[]))?;

    // --- assistant/chunk (waterfall: transform the streamed text) ---
    // We emit the reply as a single chunk here; a streaming model would emit many.
    let chunk = reg.dispatch(Event::LlmChunk, json!({ "turn": turn, "index": 0, "text": raw_reply }));
    let reply = chunk
        .value
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or(&raw_reply)
        .to_string();

    // --- assistant/message (observe) ---
    let _ = reg.dispatch(Event::AssistantMessage, json!({ "turn": turn, "text": reply }));

    // --- tool calls: parse `TOOL <name> <json>` lines from the reply ---
    let mut executed = Vec::new();
    for line in reply.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("TOOL ") else {
            continue;
        };
        let mut it = rest.splitn(2, ' ');
        let name = it.next().unwrap_or("").to_string();
        let args: Value = it
            .next()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| json!({}));

        // --- tool/call (observe) ---
        let _ = reg.dispatch(Event::ToolCall, json!({ "turn": turn, "name": name, "args": args }));

        // --- tools/pre-execute (waterfall: may rewrite args or veto) ---
        let pre_exec = reg.dispatch(
            Event::ToolsPreExecute,
            json!({ "turn": turn, "name": name, "args": args }),
        );
        if let Some(by) = pre_exec.vetoed_by {
            let _ = reg.dispatch(Event::TurnEnd, json!({ "turn": turn, "vetoed_by": by }));
            return Ok(TurnOutcome {
                turn,
                reply,
                executed,
                vetoed: Some(by),
            });
        }
        let args = pre_exec
            .value
            .get("args")
            .cloned()
            .unwrap_or_else(|| json!({}));

        // --- execute ---
        let result = reg
            .call_tool(&name, &args)
            .unwrap_or_else(|e| json!({ "kind": "error", "message": e.to_string() }));

        // --- tool/result (waterfall: may rewrite the result) ---
        let post = reg.dispatch(
            Event::ToolResult,
            json!({ "turn": turn, "name": name, "result": result }),
        );
        let result = post
            .value
            .get("result")
            .cloned()
            .unwrap_or_else(|| json!(null));

        executed.push((name, args, result));
    }

    // --- turn/end (observe) ---
    let _ = reg.dispatch(
        Event::TurnEnd,
        json!({ "turn": turn, "reply": reply, "tools": executed.len() }),
    );

    Ok(TurnOutcome {
        turn,
        reply,
        executed,
        vetoed: None,
    })
}
