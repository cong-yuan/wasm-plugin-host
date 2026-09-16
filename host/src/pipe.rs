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
}

impl PipeState {
    fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            if b == b'\n' {
                // Strip a trailing '\r' from CRLF.
                if self.partial.last() == Some(&b'\r') {
                    self.partial.pop();
                }
                let line = std::mem::take(&mut self.partial);
                self.emit(&line);
            } else {
                self.partial.push(b);
            }
        }
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
        Self {
            state: Arc::new(std::sync::Mutex::new(PipeState {
                sink,
                slot: slot.into(),
                plugin: plugin.into(),
                channel,
                partial: Vec::new(),
            })),
        }
    }

    fn write(&self, buf: &[u8]) {
        // Mutex poisoning would only happen if a log hook panicked; recover so
        // plugin output never takes down the host.
        let mut st = match self.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        st.feed(buf);
    }
}

impl IsTerminal for LogPipe {
    fn is_terminal(&self) -> bool {
        false
    }
}

impl StdoutStream for LogPipe {
    fn async_stream(&self) -> Box<dyn tokio::io::AsyncWrite + Send + Sync> {
        Box::new(LogPipeWriter {
            pipe: self.clone(),
        })
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
        self.pipe.write(buf);
        Poll::Ready(Ok(buf.len()))
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
pub fn log_pipes(
    sink: Arc<LogSink>,
    slot: &str,
    plugin: &str,
) -> (LogPipe, LogPipe) {
    (
        LogPipe::new(sink.clone(), slot, plugin, Channel::Stdout),
        LogPipe::new(sink, slot, plugin, Channel::Stderr),
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
        p.write(b"one\ntwo\nthree");
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
        p.write(b"par");
        p.write(b"tial\n");
        let recs = s.snapshot();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].message, "partial");
    }

    #[test]
    fn strips_crlf_and_tags_channels() {
        let s = sink();
        let out = LogPipe::new(s.clone(), "slot", "plug", Channel::Stdout);
        let err = LogPipe::new(s.clone(), "slot", "plug", Channel::Stderr);
        out.write(b"hello\r\n");
        err.write(b"bad\n");
        let recs = s.snapshot();
        assert_eq!(recs[0].message, "hello");
        assert_eq!(recs[0].level, LogLevel::Info);
        assert_eq!(recs[1].message, "bad");
        assert_eq!(recs[1].level, LogLevel::Error);
    }
}
