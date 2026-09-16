//! Interception — how plugins **enter the flow**.
//!
//! A plugin that only declares `tools` is a leaf: the flow calls it. A plugin
//! that declares `hooks` is a *participant*: it is called *at* flow points, and
//! can observe, veto, or rewrite what happens next. This is the dsh model.
//!
//! Two kinds of point:
//!
//! * **Observe** (`HookMode::Observe`) — the plugin sees the payload; its reply
//!   is discarded. For logging, metrics, telemetry, side effects.
//! * **Waterfall** (`HookMode::Waterfall`) — the flow passes a value through the
//!   subscribers, each of which may **rewrite** it (return the new value) or
//!   **veto** the step (return a veto). This is dsh's `next()` waterfall.
//!
//! ## Event vocabulary
//!
//! Kept close to dsh so the two are recognisable side by side:
//!
//! | Event | Fires | Payload in | Decision out |
//! |---|---|---|---|
//! | `turn/start` | a turn begins | `{turn}` | observe only |
//! | `agent/pre-step` | before a step runs | `{step, input}` | may rewrite/veto |
//! | `agent/request` | before the model is called | `{messages, tools}` | may rewrite/veto |
//! | `llm/chunk` | each streamed chunk | `{index, text}` | may rewrite |
//! | `assistant/message` | a full assistant message | `{text}` | observe only |
//! | `tool/call` | a tool is about to run | `{name, args}` | observe only |
//! | `tools/pre-execute` | right before a tool body | `{name, args}` | may rewrite/veto |
//! | `tool/result` | after a tool returns | `{name, result}` | may rewrite |
//! | `turn/end` | a turn finishes | `{turn}` | observe only |
//!
//! ## Decisions
//!
//! A waterfall hook replies with one of:
//!
//! ```json
//! { "kind": "continue" }                 // pass through unchanged
//! { "kind": "rewrite", "value": {...} }  // replace the payload and continue
//! { "kind": "veto", "reason": "..." }    // stop the step with this reason
//! ```
//!
//! A hook that errors is treated as `continue` (it cannot wedge the flow), unless
//! it is a waterfall hook and the error is a panic — in which case the plugin is
//! disabled for the rest of the turn. (Errors never abort the whole run.)

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// A flow point a plugin may subscribe to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Event {
    TurnStart,
    AgentPreStep,
    AgentRequest,
    LlmChunk,
    AssistantMessage,
    ToolCall,
    ToolsPreExecute,
    ToolResult,
    TurnEnd,
}

impl Event {
    pub fn as_str(self) -> &'static str {
        match self {
            Event::TurnStart => "turn/start",
            Event::AgentPreStep => "agent/pre-step",
            Event::AgentRequest => "agent/request",
            Event::LlmChunk => "llm/chunk",
            Event::AssistantMessage => "assistant/message",
            Event::ToolCall => "tool/call",
            Event::ToolsPreExecute => "tools/pre-execute",
            Event::ToolResult => "tool/result",
            Event::TurnEnd => "turn/end",
        }
    }

    pub fn parse(s: &str) -> Option<Event> {
        Some(match s {
            "turn/start" => Event::TurnStart,
            "agent/pre-step" => Event::AgentPreStep,
            "agent/request" => Event::AgentRequest,
            "llm/chunk" => Event::LlmChunk,
            "assistant/message" => Event::AssistantMessage,
            "tool/call" => Event::ToolCall,
            "tools/pre-execute" => Event::ToolsPreExecute,
            "tool/result" => Event::ToolResult,
            "turn/end" => Event::TurnEnd,
            _ => return None,
        })
    }

    /// The full vocabulary, for `describe` validation and error messages.
    pub const ALL: [Event; 9] = [
        Event::TurnStart,
        Event::AgentPreStep,
        Event::AgentRequest,
        Event::LlmChunk,
        Event::AssistantMessage,
        Event::ToolCall,
        Event::ToolsPreExecute,
        Event::ToolResult,
        Event::TurnEnd,
    ];
}

/// The decision a waterfall hook returns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Decision {
    /// Continue with the payload unchanged.
    Continue,
    /// Replace the payload with `value` and continue.
    Rewrite {
        value: serde_json::Value,
    },
    /// Stop the step. `reason` is surfaced to the caller/log.
    Veto {
        #[serde(default)]
        reason: String,
    },
}

impl Decision {
    /// Parse a hook reply; anything unrecognised is `Continue` (fail-open).
    pub fn parse(reply: &serde_json::Value) -> Decision {
        serde_json::from_value(reply.clone()).unwrap_or(Decision::Continue)
    }
}

/// A subscription as recorded, with its event (for read-only inspection).
#[derive(Debug, Clone)]
pub struct SubscriptionRecord {
    pub event: Event,
    pub slot: String,
    pub plugin: String,
    pub exec: String,
}

/// Who is subscribed, and in what order.
#[derive(Debug, Clone)]
pub struct Subscription {
    pub slot: String,
    pub plugin: String,
    pub exec: String,
    pub mode: crate::plugin::HookMode,
    pub priority: i32,
}

/// The dispatcher: holds the subscription table and runs a waterfall.
#[derive(Default)]
pub struct Hooks {
    subs: Vec<(Event, Subscription)>,
}

/// The outcome of dispatching one event.
#[derive(Debug)]
pub struct Dispatch {
    /// The (possibly rewritten) payload after all subscribers ran.
    pub value: serde_json::Value,
    /// The subscriber that vetoed, if any. Flow should stop.
    pub vetoed_by: Option<String>,
    /// Number of subscribers that ran.
    pub ran: usize,
    /// Slots whose hook errored (they were skipped; flow continued).
    pub errored: Vec<String>,
}

impl Hooks {
    pub fn new() -> Self {
        Self { subs: Vec::new() }
    }

    /// Drop every subscription owned by `slot` (on unload/reload).
    pub fn remove_slot(&mut self, slot: &str) {
        self.subs.retain(|(_, s)| s.slot != slot);
    }

    /// Register a slot's hooks from its declaration.
    pub fn add_slot(
        &mut self,
        slot: &str,
        plugin: &str,
        hooks: &[crate::plugin::HookDecl],
    ) -> Result<Vec<Event>> {
        let mut registered = Vec::new();
        for h in hooks {
            let ev = Event::parse(&h.on).ok_or_else(|| {
                anyhow::anyhow!(
                    "plugin `{plugin}` subscribes to unknown event `{}` (known: {})",
                    h.on,
                    Event::ALL
                        .iter()
                        .map(|e| e.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })?;
            self.subs.push((
                ev,
                Subscription {
                    slot: slot.to_string(),
                    plugin: plugin.to_string(),
                    exec: h.exec.clone(),
                    mode: h.mode,
                    priority: h.priority,
                },
            ));
            registered.push(ev);
        }
        // Stable order: by priority, then registration order.
        self.subs.sort_by_key(|(_, s)| s.priority);
        Ok(registered)
    }

    /// Read-only view of every current subscription.
    pub fn subscribers_all(&self) -> Vec<SubscriptionRecord> {
        self.subs
            .iter()
            .map(|(ev, s)| SubscriptionRecord {
                event: *ev,
                slot: s.slot.clone(),
                plugin: s.plugin.clone(),
                exec: s.exec.clone(),
            })
            .collect()
    }

    /// Subscribers for an event, in run order.
    pub fn subscribers(&self, ev: Event) -> Vec<Subscription> {
        self.subs
            .iter()
            .filter(|(e, _)| *e == ev)
            .map(|(_, s)| s.clone())
            .collect()
    }

    /// Anything subscribed at all? (For deciding whether to pay JSON costs.)
    pub fn has_subscribers(&self, ev: Event) -> bool {
        self.subs.iter().any(|(e, _)| *e == ev)
    }

    pub fn len(&self) -> usize {
        self.subs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.subs.is_empty()
    }

    /// Run one event through its subscribers.
    ///
    /// `call` invokes a subscriber's `exec` with a JSON payload and returns its
    /// JSON reply. Waterfall subscribers may rewrite the value flowing through;
    /// an `Observe` subscriber's reply is ignored. A subscriber that errors is
    /// recorded and skipped — it cannot wedge the flow.
    ///
    /// The value passed to each subscriber is the value **as rewritten so far**,
    /// so a rewrite by an earlier subscriber is visible to later ones. That is
    /// the semantics dsh's waterfall has.
    pub fn dispatch<F>(
        &self,
        ev: Event,
        mut value: serde_json::Value,
        mut call: F,
    ) -> Dispatch
    where
        F: FnMut(&Subscription, &serde_json::Value) -> Result<serde_json::Value>,
    {
        let mut ran = 0usize;
        let mut errored = Vec::new();
        let mut vetoed_by = None;

        for sub in self.subscribers(ev) {
            ran += 1;
            let payload = serde_json::json!({ "event": ev.as_str(), "value": value });
            match call(&sub, &payload) {
                Ok(reply) => {
                    if sub.mode == crate::plugin::HookMode::Waterfall {
                        match Decision::parse(&reply) {
                            Decision::Continue => {}
                            Decision::Rewrite { value: v } => value = v,
                            Decision::Veto { .. } => {
                                vetoed_by = Some(sub.slot.clone());
                                break;
                            }
                        }
                    }
                    // Observe: reply ignored.
                }
                Err(_e) => {
                    // Fail-open: a broken hook is skipped, never wedges the flow.
                    errored.push(sub.slot.clone());
                }
            }
        }

        Dispatch {
            value,
            vetoed_by,
            ran,
            errored,
        }
    }
}
