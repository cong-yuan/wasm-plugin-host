//! Shared host-side state type stored in every `Store`.
//!
//! Holds the WASI context, the plugin's live config, and a **bounded** log sink
//! fed by the `host.log` import. The sink is a ring buffer (so a chatty plugin
//! cannot grow memory without bound) and can also forward each record to a host
//! callback (for a UI/Tauri layer).

use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, AtomicU8};
use std::sync::{Arc, Mutex};
use wasmtime::component::ResourceTable;
use wasmtime_wasi::p1::WasiP1Ctx;
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

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
        inner.buf.retain(|r| level_to_u8(r.level) >= threshold);
        before - inner.buf.len()
    }
}

#[derive(Clone)]
pub struct Preview2HttpHooks {
    gate: crate::capability::CapabilityGate,
}

impl Preview2HttpHooks {
    fn new(gate: crate::capability::CapabilityGate) -> Self {
        Self { gate }
    }

    fn authorize_request(&self, url: &str, method: &str) -> Result<(), String> {
        self.gate.require_http(url, method)
    }
}

impl wasmtime_wasi_http::p2::WasiHttpHooks for Preview2HttpHooks {
    fn send_request(
        &mut self,
        request: hyper::Request<wasmtime_wasi_http::p2::body::HyperOutgoingBody>,
        config: wasmtime_wasi_http::p2::types::OutgoingRequestConfig,
    ) -> wasmtime_wasi_http::p2::HttpResult<wasmtime_wasi_http::p2::types::HostFutureIncomingResponse>
    {
        let url = request.uri().to_string();
        let method = request.method().as_str();
        if let Err(reason) = self.authorize_request(&url, method) {
            return Err(
                wasmtime_wasi_http::p2::bindings::http::types::ErrorCode::InternalError(Some(
                    reason,
                ))
                .into(),
            );
        }
        Ok(wasmtime_wasi_http::p2::default_send_request(
            request, config,
        ))
    }
}

/// Per-`Store` host state. `T` in `Store<T>` is this type.
pub struct HostState {
    pub wasi: WasiP1Ctx,
    /// Preview2 state for Component guests. Both trust modes can instantiate
    /// Preview2 runtimes; authority is configured here (trusted inheritance vs
    /// sandboxed read-only preopens / gated HTTP / exact-IP raw TCP).
    pub component_wasi: WasiCtx,
    pub component_table: ResourceTable,
    pub component_http: wasmtime_wasi_http::WasiHttpCtx,
    pub component_http_hooks: Preview2HttpHooks,
    /// Wasmtime's per-store resource limiter. Sandboxed plugins receive a
    /// finite linear-memory ceiling; trusted mode leaves it unrestricted.
    pub store_limits: wasmtime::StoreLimits,
    /// Bounded log sink; shared with `Plugin` so the host can read it back.
    pub log: Arc<LogSink>,
    /// The slot this instance is loaded under (used for log prefixes).
    pub slot: String,
    /// How long `host.http_fetch` may run, end to end. See
    /// `runtime::HTTP_TIMEOUT` for why this must be finite.
    pub http_timeout: std::time::Duration,
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
    /// Deployment policy plus the instance's single capability enforcement gate.
    pub policy: crate::capability::PluginPolicy,
    pub capability_gate: crate::capability::CapabilityGate,
    /// Capability-safe directory handles for host-mediated sandbox mutations.
    /// Keys are the exact configured grant roots visible to plugin declarations.
    pub fs_roots: std::collections::HashMap<String, cap_std::fs::Dir>,
    /// Host-owned security audit stream, separate from guest-controlled logs.
    pub audit: Option<Arc<crate::audit::AuditSink>>,
    /// Aggregate guest log bytes charged during the current top-level call.
    pub log_bytes_this_call: Arc<std::sync::atomic::AtomicU64>,
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
        Self::new_with_policy(
            slot,
            plugin_name,
            config,
            log,
            services,
            crate::capability::PluginPolicy::trusted(),
        )
    }

    pub fn new_with_policy(
        slot: impl Into<String>,
        plugin_name: impl Into<String>,
        config: Value,
        log: Arc<LogSink>,
        services: Option<Arc<crate::service::Shared>>,
        policy: crate::capability::PluginPolicy,
    ) -> Self {
        Self::new_with_policy_and_audit(slot, plugin_name, config, log, services, policy, None)
    }

    pub fn new_with_policy_and_audit(
        slot: impl Into<String>,
        plugin_name: impl Into<String>,
        config: Value,
        log: Arc<LogSink>,
        services: Option<Arc<crate::service::Shared>>,
        policy: crate::capability::PluginPolicy,
        audit: Option<Arc<crate::audit::AuditSink>>,
    ) -> Self {
        let slot = slot.into();
        let plugin_name = plugin_name.into();
        let log_bytes_this_call = Arc::new(std::sync::atomic::AtomicU64::new(0));
        // Route guest stdout/stderr into the log sink. This is the language-
        // agnostic channel: `println!`, `fmt.Println`, `printf`, `console.log`,
        // `print()` all land here with no per-language glue.
        let (out_pipe, err_pipe) = if policy.trust == crate::capability::TrustMode::Sandboxed {
            match audit.clone() {
                Some(audit_sink) => crate::pipe::log_pipes_with_budget_and_audit(
                    log.clone(),
                    &slot,
                    &plugin_name,
                    policy.limits.max_log_bytes_per_call,
                    log_bytes_this_call.clone(),
                    audit_sink,
                ),
                None => crate::pipe::log_pipes_with_budget(
                    log.clone(),
                    &slot,
                    &plugin_name,
                    policy.limits.max_log_bytes_per_call,
                    log_bytes_this_call.clone(),
                ),
            }
        } else {
            crate::pipe::log_pipes(log.clone(), &slot, &plugin_name)
        };
        let mut builder = WasiCtxBuilder::new();
        builder.stdout(out_pipe).stderr(err_pipe);
        if policy.trust == crate::capability::TrustMode::Trusted {
            if let Err(e) = builder.preopened_dir(
                "/",
                "/",
                wasmtime_wasi::DirPerms::all(),
                wasmtime_wasi::FilePerms::all(),
            ) {
                eprintln!("[host] could not preopen / for plugin {plugin_name}: {e}");
            }
        } else {
            // WASI preopens must exist before instantiation, while ABI-v1's
            // plugin_describe runs afterwards. Therefore direct WASI filesystem
            // access is bounded by the host grant itself. The late plugin
            // request still gates host-mediated capabilities, but is not a
            // security boundary for these preopens.
            let mut paths: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
            for path in &policy.grant.filesystem.read {
                paths.insert(path.clone());
            }
            for path in paths {
                let dir_perms = wasmtime_wasi::DirPerms::READ;
                let file_perms = wasmtime_wasi::FilePerms::READ;
                // load_with_policy validates/canonicalizes the authority first;
                // resolve again here so the preopen is rooted at the stable real
                // directory while preserving the configured guest-visible alias.
                let canonical = std::fs::canonicalize(&path)
                    .unwrap_or_else(|_| std::path::PathBuf::from(path.clone()));
                if let Err(e) = builder.preopened_dir(&canonical, &path, dir_perms, file_perms) {
                    eprintln!(
                        "[host] could not preopen sandbox grant {path} for plugin {plugin_name}: {e}"
                    );
                }
            }
        }
        let ctx = builder.build_p1();
        let capability_gate = match audit.clone() {
            Some(sink) => crate::capability::CapabilityGate::with_audit(
                &policy,
                sink,
                slot.clone(),
                plugin_name.clone(),
            ),
            None => crate::capability::CapabilityGate::new(&policy),
        };
        let mut component_builder = WasiCtxBuilder::new();
        component_builder.allow_blocking_current_thread(true);
        if policy.trust == crate::capability::TrustMode::Trusted {
            component_builder.inherit_network();
            if let Err(e) = component_builder.preopened_dir(
                "/",
                "/",
                wasmtime_wasi::DirPerms::all(),
                wasmtime_wasi::FilePerms::all(),
            ) {
                eprintln!(
                    "[host] could not preopen / for trusted Component plugin {plugin_name}: {e}"
                );
            }
        } else {
            let socket_gate = capability_gate.clone();
            component_builder.allow_tcp(true);
            component_builder.allow_udp(false);
            component_builder.allow_ip_name_lookup(false);
            component_builder.socket_addr_check(move |addr, use_| {
                let gate = socket_gate.clone();
                Box::pin(async move {
                    matches!(use_, wasmtime_wasi::sockets::SocketAddrUse::TcpConnect)
                        && gate.require_socket_ip(addr.ip()).is_ok()
                })
            });

            // Preview2 directory permissions collapse mutation operations into
            // one MUTATE bit. Mapping write/create/delete here would therefore
            // widen our finer capability model. Only read grants are exposed
            // directly; mutations stay on the host-mediated WIT filesystem API.
            for path in &policy.grant.filesystem.read {
                let canonical =
                    std::fs::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path));
                if let Err(e) = component_builder.preopened_dir(
                    &canonical,
                    path,
                    wasmtime_wasi::DirPerms::READ,
                    wasmtime_wasi::FilePerms::READ,
                ) {
                    eprintln!(
                        "[host] could not preopen sandbox Preview2 read grant {path} for plugin {plugin_name}: {e}"
                    );
                }
            }
        }
        let component_wasi = component_builder.build();
        let mut fs_roots = std::collections::HashMap::new();
        if policy.trust == crate::capability::TrustMode::Sandboxed {
            for path in policy
                .grant
                .filesystem
                .read
                .iter()
                .chain(policy.grant.filesystem.write.iter())
                .chain(policy.grant.filesystem.create.iter())
                .chain(policy.grant.filesystem.delete.iter())
            {
                if fs_roots.contains_key(path) {
                    continue;
                }
                let canonical =
                    std::fs::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path));
                match cap_std::fs::Dir::open_ambient_dir(&canonical, cap_std::ambient_authority()) {
                    Ok(dir) => {
                        fs_roots.insert(path.clone(), dir);
                    }
                    Err(e) => {
                        eprintln!(
                            "[host] could not open sandbox fs capability {path} for plugin {plugin_name}: {e}"
                        );
                    }
                }
            }
        }
        let store_limits = if policy.trust == crate::capability::TrustMode::Sandboxed {
            let bytes = policy
                .limits
                .memory_mb
                .saturating_mul(1024 * 1024)
                .min(usize::MAX as u64) as usize;
            wasmtime::StoreLimitsBuilder::new()
                .memory_size(bytes)
                .trap_on_grow_failure(true)
                .build()
        } else {
            wasmtime::StoreLimitsBuilder::new().build()
        };
        Self {
            wasi: ctx,
            component_wasi,
            component_table: ResourceTable::new(),
            component_http: wasmtime_wasi_http::WasiHttpCtx::new(),
            component_http_hooks: Preview2HttpHooks::new(capability_gate.clone()),
            store_limits,
            log,
            slot,
            http_timeout: crate::runtime::HTTP_TIMEOUT,
            plugin_name,
            config: Arc::new(Mutex::new(config)),
            config_version: Arc::new(AtomicI64::new(1)),
            services,
            policy,
            capability_gate,
            fs_roots,
            audit,
            log_bytes_this_call,
        }
    }

    pub fn reset_call_log_budget(&self) {
        self.log_bytes_this_call
            .store(0, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn charge_log_bytes(&self, bytes: u64) -> Result<(), String> {
        if self.policy.trust == crate::capability::TrustMode::Trusted {
            return Ok(());
        }
        let max = self.policy.limits.max_log_bytes_per_call;
        let result = self
            .log_bytes_this_call
            .fetch_update(
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
                |used| used.checked_add(bytes).filter(|next| *next <= max),
            )
            .map(|_| ())
            .map_err(|used| {
                format!("permission denied: plugin log budget exceeded ({used}+{bytes} > {max})")
            });
        if let Err(reason) = &result {
            self.audit_resource_limit(
                "limits.max_log_bytes_per_call",
                &format!("{bytes} bytes"),
                reason,
            );
        }
        result
    }

    pub fn audit_resource_limit(&self, capability: &str, target: &str, reason: &str) {
        if let Some(audit) = &self.audit {
            audit.record(
                &self.slot,
                &self.plugin_name,
                crate::audit::AuditDecision::Limit,
                capability,
                target,
                Some(reason),
            );
        }
    }

    pub fn resolve_declared_capabilities(&self, requested: &crate::capability::CapabilitySet) {
        self.capability_gate.resolve(&self.policy, requested);
    }
}

impl WasiView for HostState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.component_wasi,
            table: &mut self.component_table,
        }
    }
}

impl wasmtime_wasi_http::p2::WasiHttpView for HostState {
    fn http(&mut self) -> wasmtime_wasi_http::p2::WasiHttpCtxView<'_> {
        wasmtime_wasi_http::p2::WasiHttpCtxView {
            ctx: &mut self.component_http,
            table: &mut self.component_table,
            hooks: &mut self.component_http_hooks,
        }
    }
}

#[cfg(test)]
mod preview2_tests {
    use super::*;
    use crate::capability::{CapabilitySet, NetworkCapabilities, PluginPolicy, TrustMode};

    #[test]
    fn preview2_http_hook_reuses_network_capability_gate() {
        let requested = CapabilitySet {
            network: NetworkCapabilities {
                allow: vec!["api.example.com".into()],
                methods: vec!["GET".into()],
            },
            ..Default::default()
        };
        let policy = PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: requested.clone(),
            ..Default::default()
        };
        let gate = crate::capability::CapabilityGate::new(&policy);
        gate.resolve(&policy, &requested);
        let hooks = Preview2HttpHooks::new(gate);

        assert!(hooks
            .authorize_request("https://api.example.com/v1", "GET")
            .is_ok());
        assert!(hooks
            .authorize_request("https://api.example.com/v1", "POST")
            .is_err());
        assert!(hooks.authorize_request("http://127.0.0.1/", "GET").is_err());
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
