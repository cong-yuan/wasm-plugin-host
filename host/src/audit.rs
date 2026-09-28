//! Security audit events for capability decisions.
//!
//! This is deliberately separate from plugin logs: a plugin must not be able to
//! hide, forge, or consume the host's security decision stream.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditDecision {
    Allow,
    Deny,
    Limit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditEvent {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub slot: String,
    pub plugin: String,
    pub decision: AuditDecision,
    pub capability: String,
    pub target: String,
    pub reason: Option<String>,
}

#[derive(Debug)]
struct Inner {
    buf: VecDeque<AuditEvent>,
    next_seq: u64,
}

/// Bounded host-owned ring buffer. Older events are discarded first.
#[derive(Debug)]
pub struct AuditSink {
    inner: Mutex<Inner>,
    capacity: usize,
}

pub const DEFAULT_AUDIT_CAPACITY: usize = 2048;

impl Default for AuditSink {
    fn default() -> Self {
        Self::new(DEFAULT_AUDIT_CAPACITY)
    }
}

impl AuditSink {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                buf: VecDeque::with_capacity(capacity.min(4096)),
                next_seq: 0,
            }),
            capacity: capacity.max(1),
        }
    }

    pub fn record(
        &self,
        slot: &str,
        plugin: &str,
        decision: AuditDecision,
        capability: &str,
        target: &str,
        reason: Option<&str>,
    ) {
        let mut inner = self.inner.lock().unwrap();
        inner.next_seq += 1;
        let event = AuditEvent {
            seq: inner.next_seq,
            timestamp_ms: now_ms(),
            slot: slot.to_string(),
            plugin: plugin.to_string(),
            decision,
            capability: bounded(capability, 128),
            target: bounded(target, 1024),
            reason: reason.map(|s| bounded(s, 1024)),
        };
        while inner.buf.len() >= self.capacity {
            inner.buf.pop_front();
        }
        inner.buf.push_back(event);
    }

    pub fn snapshot(&self) -> Vec<AuditEvent> {
        self.inner.lock().unwrap().buf.iter().cloned().collect()
    }

    pub fn for_slot(&self, slot: &str) -> Vec<AuditEvent> {
        self.inner
            .lock()
            .unwrap()
            .buf
            .iter()
            .filter(|e| e.slot == slot)
            .cloned()
            .collect()
    }

    pub fn since(&self, seq: u64) -> Vec<AuditEvent> {
        self.inner
            .lock()
            .unwrap()
            .buf
            .iter()
            .filter(|e| e.seq > seq)
            .cloned()
            .collect()
    }

    pub fn clear(&self) {
        self.inner.lock().unwrap().buf.clear();
    }
}

fn bounded(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let out: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{out}…")
    } else {
        out
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_sink_is_bounded_and_filterable() {
        let sink = AuditSink::new(2);
        sink.record("a", "pa", AuditDecision::Allow, "network.http", "GET x", None);
        sink.record(
            "b",
            "pb",
            AuditDecision::Deny,
            "service.consume",
            "kv",
            Some("denied"),
        );
        sink.record("a", "pa", AuditDecision::Allow, "ui.theme", "theme", None);

        let all = sink.snapshot();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].slot, "b");
        assert_eq!(sink.for_slot("a").len(), 1);
        assert_eq!(sink.since(all[0].seq).len(), 1);
    }
}
