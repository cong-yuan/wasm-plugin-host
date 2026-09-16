//! Shared host-side state type stored in every `Store`.
//!
//! Holds the WASI context, the plugin's live config, and a **bounded** log sink
//! fed by the `host.log` import. The sink is a ring buffer (so a chatty plugin
//! cannot grow memory without bound) and can also forward each record to a host
//! callback (for a UI/Tauri layer).

use wasmtime_wasi::p1::WasiP1Ctx;
use wasmtime_wasi::WasiCtxBuilder;
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, AtomicU8};
use std::sync::{Arc, Mutex};

/// Severity of a log line, mirroring the integer levels the ABI uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn from_i32(v: i32) -> Self {
        match v {
            0 => LogLevel::Debug,
            1 => LogLevel::Info,
            2 => LogLevel::Warn,
            _ => LogLevel::Error,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }

    /// Parse a level name (case-insensitive). Used by config validation.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.trim().to_ascii_lowercase().as_str() {
            "debug" | "trace" => LogLevel::Debug,
            "info" => LogLevel::Info,
            "warn" | "warning" => LogLevel::Warn,
            "error" | "err" => LogLevel::Error,
            _ => return None,
        })
    }
}

/// One log line emitted by a plugin.
#[derive(Debug, Clone, Serialize)]
pub struct LogRecord {
    /// Monotonic sequence number, unique across the process. Lets a consumer
    /// tail logs (`since(seq)`) without re-reading old lines.
    pub seq: u64,
    /// The slot that emitted it (e.g. `greet`).
    pub slot: String,
    /// The plugin's own declared/detected name (e.g. `hello-rust`).
    pub plugin: String,
    pub level: LogLevel,
    pub message: String,
}

impl LogRecord {
    /// Convenience rendering, e.g. `[greet] info: hello`.
    pub fn render(&self) -> String {
        format!("[{}] {}: {}", self.slot, self.level.as_str(), self.message)
    }
}

/// A host-side callback invoked for every log record. Must be cheap and
/// non-blocking: it runs on the plugin's calling thread.
pub type LogHook = Arc<dyn Fn(&LogRecord) + Send + Sync + 'static>;

struct Inner {
    buf: VecDeque<LogRecord>,
    next_seq: u64,
}

/// A bounded, thread-safe log ring buffer with an optional forwarder.
pub struct LogSink {
    inner: Mutex<Inner>,
    capacity: usize,
    echo_stderr: bool,
    hook: Option<LogHook>,
    /// Records below this level are discarded entirely (never buffered or
    /// forwarded). Stored as an atomic so `set_min_level` is lock-free and can
    /// be called while a plugin is logging on another thread.
    min_level: AtomicU8,
}

impl LogSink {
    /// `capacity` is the maximum number of records retained (older ones are
    /// dropped). `echo_stderr` mirrors lines to the process's stderr.
    pub fn new(capacity: usize, echo_stderr: bool, hook: Option<LogHook>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                buf: VecDeque::with_capacity(capacity.min(4096)),
                next_seq: 0,
            }),
            capacity: capacity.max(1),
            echo_stderr,
            hook,
            min_level: AtomicU8::new(level_to_u8(LogLevel::Debug)),
        }
    }

    /// Discard records below `level`. Default is `Debug` (keep everything).
    pub fn set_min_level(&self, level: LogLevel) {
        self.min_level
            .store(level_to_u8(level), std::sync::atomic::Ordering::Relaxed);
    }

    /// The current minimum retained level.
    pub fn min_level(&self) -> LogLevel {
        u8_to_level(self.min_level.load(std::sync::atomic::Ordering::Relaxed))
    }

    /// Record a line. Assigns the sequence number, trims to capacity, mirrors to
    /// stderr if enabled, and forwards to the hook (outside the lock, so a hook
    /// that re-enters the sink cannot deadlock).
    pub fn push(&self, mut rec: LogRecord) {
        // Level filter: below-threshold records are dropped before they cost a
        // buffer slot or a hook call.
        if level_to_u8(rec.level) < self.min_level.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        {
            let mut inner = self.inner.lock().unwrap();
            inner.next_seq += 1;
            rec.seq = inner.next_seq;
            while inner.buf.len() >= self.capacity {
                inner.buf.pop_front();
            }
            inner.buf.push_back(rec.clone());
        }
        if self.echo_stderr {
            eprintln!("{}", rec.render());
        }
        if let Some(hook) = &self.hook {
            hook(&rec);
        }
    }

    /// All currently buffered records, oldest first.
    pub fn snapshot(&self) -> Vec<LogRecord> {
        self.inner.lock().unwrap().buf.iter().cloned().collect()
    }

    /// The most recent `n` records, oldest first.
    pub fn recent(&self, n: usize) -> Vec<LogRecord> {
        let inner = self.inner.lock().unwrap();
        let len = inner.buf.len();
        let start = len.saturating_sub(n);
        inner.buf.iter().skip(start).cloned().collect()
    }

    /// Records with `seq` greater than `since` (for tailing).
    pub fn since(&self, since: u64) -> Vec<LogRecord> {
        self.inner
            .lock()
            .unwrap()
            .buf
            .iter()
            .filter(|r| r.seq > since)
            .cloned()
            .collect()
    }

    /// Drain and return everything buffered.
    pub fn take(&self) -> Vec<LogRecord> {
        let mut inner = self.inner.lock().unwrap();
        inner.buf.drain(..).collect()
    }

    pub fn clear(&self) {
        self.inner.lock().unwrap().buf.clear();
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Drop every buffered record below `level`, returning how many were
    /// removed. Used when the level is raised at runtime so the buffer does not
    /// hold lines that would no longer be admitted.
    pub fn prune_below(&self, level: LogLevel) -> usize {
        let threshold = level_to_u8(level);
        let mut inner = self.inner.lock().unwrap();
        let before = inner.buf.len();
        inner
            .buf
            .retain(|r| level_to_u8(r.level) >= threshold);
        before - inner.buf.len()
    }
}

/// Per-`Store` host state. `T` in `Store<T>` is this type.
pub struct HostState {
    pub wasi: WasiP1Ctx,
    /// Bounded log sink; shared with `Plugin` so the host can read it back.
    pub log: Arc<LogSink>,
    /// The slot this instance is loaded under (used for log prefixes).
    pub slot: String,
    /// The plugin's own name (from its file stem / declaration).
    pub plugin_name: String,
    /// The plugin's live config. The host pushes updates here; the plugin reads
    /// it whenever it wants through the `host.get_config` import. Shared by
    /// `Arc<Mutex<..>>` so `Plugin::set_config` can swap it while the guest
    /// holds a `Caller` into this same store.
    pub config: Arc<Mutex<Value>>,
    /// Bumped on every config change, so a plugin can cheaply detect a change
    /// (via `host.config_version`) before copying the whole config.
    pub config_version: Arc<AtomicI64>,
    /// The shared plugin store + service table. Present when the host wired in
    /// cross-plugin service calls; `host.call_service` uses it. `None` disables
    /// that import (the guest gets a clear error instead of a crash).
    pub services: Option<Arc<crate::service::Shared>>,
}

impl HostState {
    /// Build host state whose WASI stdout/stderr are captured into `log`.
    pub fn new(
        slot: impl Into<String>,
        plugin_name: impl Into<String>,
        config: Value,
        log: Arc<LogSink>,
        services: Option<Arc<crate::service::Shared>>,
    ) -> Self {
        let slot = slot.into();
        let plugin_name = plugin_name.into();
        // Route guest stdout/stderr into the log sink. This is the language-
        // agnostic channel: `println!`, `fmt.Println`, `printf`, `console.log`,
        // `print()` all land here with no per-language glue.
        let (out_pipe, err_pipe) =
            crate::pipe::log_pipes(log.clone(), &slot, &plugin_name);
        // Capability model: plugins are **trusted**, so they get full filesystem
        // access — the whole host root is preopened read/write. This is a
        // deliberate product decision (see docs/已知问题.md); it means a plugin
        // can read and write any file the app can. Narrow this to a sandbox
        // directory when untrusted plugins must be supported.
        let mut builder = WasiCtxBuilder::new();
        builder.stdout(out_pipe).stderr(err_pipe);
        if let Err(e) = builder.preopened_dir(
            "/",
            "/",
            wasmtime_wasi::DirPerms::all(),
            wasmtime_wasi::FilePerms::all(),
        ) {
            // Never fatal: a host that cannot preopen (e.g. an unusual root)
            // still runs, just without filesystem access.
            eprintln!("[host] could not preopen `/` for plugin `{plugin_name}`: {e}");
        }
        let ctx = builder.build_p1();
        Self {
            wasi: ctx,
            log,
            slot,
            plugin_name,
            config: Arc::new(Mutex::new(config)),
            config_version: Arc::new(AtomicI64::new(1)),
            services,
        }
    }
}

/// Default bound on retained log records per plugin.
pub const DEFAULT_LOG_CAPACITY: usize = 1000;

fn level_to_u8(l: LogLevel) -> u8 {
    match l {
        LogLevel::Debug => 0,
        LogLevel::Info => 1,
        LogLevel::Warn => 2,
        LogLevel::Error => 3,
    }
}

fn u8_to_level(v: u8) -> LogLevel {
    match v {
        0 => LogLevel::Debug,
        1 => LogLevel::Info,
        2 => LogLevel::Warn,
        _ => LogLevel::Error,
    }
}
