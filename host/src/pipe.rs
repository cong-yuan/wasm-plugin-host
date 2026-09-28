//! Universal plugin output capture via **WASI stdout/stderr**.
//!
//! `host.log` requires the guest to hand-write glue: allocate a buffer, copy
//! UTF-8 into it, call the import. That is fine for Rust but burdensome in Go,
//! and impossible in languages that don't expose raw linear-memory pointers
//! easily. It is also *not* how these languages normally print.
//!
//! Almost every language's idiomatic print already targets WASI stdout/stderr:
//!
//! | Language | call            |
//! |----------|-----------------|
//! | Rust     | `println!`      |
//! | Go       | `fmt.Println`   |
//! | C        | `printf`        |
//! | Zig      | `std.debug.print` |
//! | JS (jco) | `console.log`   |
//! | Python   | `print()`       |
//!
//! So the **universal** log channel is: give the instance a custom
//! `StdoutStream`/`StderrStream` that pipes bytes into the host's [`LogSink`].
//! The plugin writes nothing special; a line on stdout becomes a log record.
//!
//! This works for any WASI-compliant module regardless of source language.
//! `host.log` remains available as an *optional* structured upgrade for guests
//! that want to set an explicit level; both feed the same sink.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use wasmtime_wasi::cli::{IsTerminal, StdoutStream};

use crate::state::{LogLevel, LogRecord, LogSink};

/// Which WASI fd a stream feeds. Stdout is logged at `Info`, stderr at `Error`
/// (a common convention: diagnostics go to stderr).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Stdout,
    Stderr,
}

impl Channel {
    fn level(self) -> LogLevel {
        match self {
            Channel::Stdout => LogLevel::Info,
            Channel::Stderr => LogLevel::Error,
        }
    }
}

/// Buffers bytes written by the guest, splitting them into whole lines and
/// pushing each complete line into the shared [`LogSink`]. A trailing partial
/// line is held until the next write (or flushed on drop).
struct PipeState {
    sink: Arc<LogSink>,
    slot: String,
    plugin: String,
    channel: Channel,
    partial: Vec<u8>,
    max_record_bytes: Option<usize>,
    call_budget: Option<(Arc<AtomicU64>, u64)>,
    audit: Option<Arc<crate::audit::AuditSink>>,
}

impl PipeState {
    fn feed(&mut self, bytes: &[u8]) -> io::Result<()> {
        if let Some((used, max)) = &self.call_budget {
            let add = bytes.len() as u64;
            let result = used.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
                current.checked_add(add).filter(|next| *next <= *max)
            });
            if let Err(current) = result {
                let reason =
                    format!("plugin call log budget exceeded ({current}+{add} > {max})");
                if let Some(audit) = &self.audit {
                    audit.record(
                        &self.slot,
                        &self.plugin,
                        crate::audit::AuditDecision::Limit,
                        "limits.max_log_bytes_per_call",
                        &format!("{add} bytes"),
                        Some(&reason),
                    );
                }
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, reason));
            }
        }
        for &b in bytes {
            if b == b'\n' {
                // Strip a trailing '\r' from CRLF.
                if self.partial.last() == Some(&b'\r') {
                    self.partial.pop();
                }
                let line = std::mem::take(&mut self.partial);
                self.emit(&line);
            } else {
                if self
                    .max_record_bytes
                    .is_some_and(|max| self.partial.len() >= max)
                {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "plugin log record exceeds configured byte cap",
                    ));
                }
                self.partial.push(b);
            }
        }
        Ok(())
    }

    fn emit(&self, raw: &[u8]) {
        // Emit even empty lines: they are meaningful in output.
        let message = String::from_utf8_lossy(raw).into_owned();
        self.sink.push(LogRecord {
            seq: 0,
            slot: self.slot.clone(),
            plugin: self.plugin.clone(),
            level: self.channel.level(),
            message,
        });
    }

    fn flush_partial(&mut self) {
        if !self.partial.is_empty() {
            let line = std::mem::take(&mut self.partial);
            self.emit(&line);
        }
    }
}

impl Drop for PipeState {
    fn drop(&mut self) {
        // Don't lose a trailing line with no newline (very common: a final
        // `println!` in a command module, or a message printed without '\n').
        self.flush_partial();
    }
}

/// A `StdoutStream`/`StderrStream` that routes guest output into the host log.
#[derive(Clone)]
pub struct LogPipe {
    state: Arc<std::sync::Mutex<PipeState>>,
}

impl LogPipe {
    pub fn new(
        sink: Arc<LogSink>,
        slot: impl Into<String>,
        plugin: impl Into<String>,
        channel: Channel,
    ) -> Self {
        Self::new_with_limit(sink, slot, plugin, channel, None)
    }

    pub fn new_with_limit(
        sink: Arc<LogSink>,
        slot: impl Into<String>,
        plugin: impl Into<String>,
        channel: Channel,
        max_record_bytes: Option<usize>,
    ) -> Self {
        Self {
            state: Arc::new(std::sync::Mutex::new(PipeState {
                sink,
                slot: slot.into(),
                plugin: plugin.into(),
                channel,
                partial: Vec::new(),
                max_record_bytes,
                call_budget: None,
                audit: None,
            })),
        }
    }

    pub fn new_with_call_budget(
        sink: Arc<LogSink>,
        slot: impl Into<String>,
        plugin: impl Into<String>,
        channel: Channel,
        used: Arc<AtomicU64>,
        max_call_bytes: u64,
    ) -> Self {
        Self {
            state: Arc::new(std::sync::Mutex::new(PipeState {
                sink,
                slot: slot.into(),
                plugin: plugin.into(),
                channel,
                partial: Vec::new(),
                max_record_bytes: None,
                call_budget: Some((used, max_call_bytes)),
                audit: None,
            })),
        }
    }

    pub fn new_with_call_budget_and_audit(
        sink: Arc<LogSink>,
        slot: impl Into<String>,
        plugin: impl Into<String>,
        channel: Channel,
        used: Arc<AtomicU64>,
        max_call_bytes: u64,
        audit: Arc<crate::audit::AuditSink>,
    ) -> Self {
        Self {
            state: Arc::new(std::sync::Mutex::new(PipeState {
                sink,
                slot: slot.into(),
                plugin: plugin.into(),
                channel,
                partial: Vec::new(),
                max_record_bytes: None,
                call_budget: Some((used, max_call_bytes)),
                audit: Some(audit),
            })),
        }
    }

    fn write(&self, buf: &[u8]) -> io::Result<()> {
        // Mutex poisoning would only happen if a log hook panicked; recover so
        // plugin output never takes down the host.
        let mut st = match self.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        st.feed(buf)
    }
}

impl IsTerminal for LogPipe {
    fn is_terminal(&self) -> bool {
        false
    }
}

impl StdoutStream for LogPipe {
    fn async_stream(&self) -> Box<dyn tokio::io::AsyncWrite + Send + Sync> {
        Box::new(LogPipeWriter { pipe: self.clone() })
    }
}

/// The actual `AsyncWrite` handed to WASI. Each `poll_write` feeds bytes into
/// the pipe state, which splits them into lines.
struct LogPipeWriter {
    pipe: LogPipe,
}

impl tokio::io::AsyncWrite for LogPipeWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.pipe.write(buf) {
            Ok(()) => Poll::Ready(Ok(buf.len())),
            Err(e) => Poll::Ready(Err(e)),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

/// Build a matched (stdout, stderr) pair feeding the same sink, tagged with the
/// given slot and plugin name.
pub fn log_pipes(sink: Arc<LogSink>, slot: &str, plugin: &str) -> (LogPipe, LogPipe) {
    (
        LogPipe::new(sink.clone(), slot, plugin, Channel::Stdout),
        LogPipe::new(sink, slot, plugin, Channel::Stderr),
    )
}

pub fn log_pipes_limited(
    sink: Arc<LogSink>,
    slot: &str,
    plugin: &str,
    max_record_bytes: usize,
) -> (LogPipe, LogPipe) {
    (
        LogPipe::new_with_limit(
            sink.clone(),
            slot,
            plugin,
            Channel::Stdout,
            Some(max_record_bytes),
        ),
        LogPipe::new_with_limit(sink, slot, plugin, Channel::Stderr, Some(max_record_bytes)),
    )
}

pub fn log_pipes_with_budget(
    sink: Arc<LogSink>,
    slot: &str,
    plugin: &str,
    max_call_bytes: u64,
    used: Arc<AtomicU64>,
) -> (LogPipe, LogPipe) {
    (
        LogPipe::new_with_call_budget(
            sink.clone(),
            slot,
            plugin,
            Channel::Stdout,
            used.clone(),
            max_call_bytes,
        ),
        LogPipe::new_with_call_budget(sink, slot, plugin, Channel::Stderr, used, max_call_bytes),
    )
}

pub fn log_pipes_with_budget_and_audit(
    sink: Arc<LogSink>,
    slot: &str,
    plugin: &str,
    max_call_bytes: u64,
    used: Arc<AtomicU64>,
    audit: Arc<crate::audit::AuditSink>,
) -> (LogPipe, LogPipe) {
    (
        LogPipe::new_with_call_budget_and_audit(
            sink.clone(),
            slot,
            plugin,
            Channel::Stdout,
            used.clone(),
            max_call_bytes,
            audit.clone(),
        ),
        LogPipe::new_with_call_budget_and_audit(
            sink,
            slot,
            plugin,
            Channel::Stderr,
            used,
            max_call_bytes,
            audit,
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sink() -> Arc<LogSink> {
        Arc::new(LogSink::new(100, false, None))
    }

    #[test]
    fn splits_on_newlines() {
        let s = sink();
        let p = LogPipe::new(s.clone(), "slot", "plug", Channel::Stdout);
        p.write(b"one\ntwo\nthree").unwrap();
        let recs = s.snapshot();
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].message, "one");
        assert_eq!(recs[1].message, "two");
        // trailing partial held until more data or drop
        drop(p);
        let recs = s.snapshot();
        assert_eq!(recs.len(), 3);
        assert_eq!(recs[2].message, "three");
    }

    #[test]
    fn handles_partial_writes_across_calls() {
        let s = sink();
        let p = LogPipe::new(s.clone(), "slot", "plug", Channel::Stdout);
        p.write(b"par").unwrap();
        p.write(b"tial\n").unwrap();
        let recs = s.snapshot();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].message, "partial");
    }

    #[test]
    fn strips_crlf_and_tags_channels() {
        let s = sink();
        let out = LogPipe::new(s.clone(), "slot", "plug", Channel::Stdout);
        let err = LogPipe::new(s.clone(), "slot", "plug", Channel::Stderr);
        out.write(b"hello\r\n").unwrap();
        err.write(b"bad\n").unwrap();
        let recs = s.snapshot();
        assert_eq!(recs[0].message, "hello");
        assert_eq!(recs[0].level, LogLevel::Info);
        assert_eq!(recs[1].message, "bad");
        assert_eq!(recs[1].level, LogLevel::Error);
    }

    #[test]
    fn limited_pipe_rejects_an_oversized_line() {
        let s = sink();
        let p = LogPipe::new_with_limit(s, "slot", "plug", Channel::Stdout, Some(4));
        p.write(b"1234").unwrap();
        let err = p.write(b"5").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn stdout_and_stderr_share_one_call_budget() {
        let s = sink();
        let used = Arc::new(AtomicU64::new(0));
        let (out, err) = log_pipes_with_budget(s, "slot", "plug", 6, used.clone());
        out.write(b"abc").unwrap();
        err.write(b"de").unwrap();
        let e = out.write(b"fg").unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(used.load(Ordering::SeqCst), 5);
    }

    #[test]
    fn wasi_log_budget_denial_is_audited() {
        let s = sink();
        let used = Arc::new(AtomicU64::new(0));
        let audit = Arc::new(crate::audit::AuditSink::new(8));
        let (out, _err) =
            log_pipes_with_budget_and_audit(s, "slot", "plug", 3, used, audit.clone());
        let e = out.write(b"abcd").unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::PermissionDenied);
        let events = audit.snapshot();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].decision, crate::audit::AuditDecision::Limit);
        assert_eq!(events[0].capability, "limits.max_log_bytes_per_call");
    }
}
