//! `Runtime` — compilation, caching, and instantiation backend.
//!
//! This is the seam where a future **Component Model** backend (for JS via
//! `jco`, Python via `componentize-py`) plugs in. For now it handles core
//! modules built for `wasm32-wasip1`.
//!
//! ## Allocation strategy and concurrency
//!
//! Two allocation strategies are supported:
//!
//! * [`AllocationStrategy::OnDemand`] (default) — each instance allocates its
//!   own memory. Fine for a handful of plugins.
//! * [`AllocationStrategy::Pooled`] — a pre-reserved pool of instance slots.
//!   Instance creation becomes O(slots) and predictable, which matters when you
//!   load many plugins or churn them (hot-reload). Requires configuring the
//!   engine up front, so it is chosen when the `Runtime` is built.
//!
//! `Store<T>` is `Send` (verified), so a `Plugin` can be moved to another thread
//! and driven there. It is **not** `Sync`: one instance is used by one thread at
//! a time. For parallelism, give each worker its own instance (see
//! [`Registry::call_tool_on`] and the `Parallel` examples), or shard slots
//! across threads. A pooled allocator makes that cheap.
//!
//! Modules are cached in-process keyed by canonical path **and mtime**, so a
//! rebuilt `.wasm` is recompiled rather than served stale.

use anyhow::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use wasmtime::{Engine, Instance, Linker, Module, Store};
use wasmtime::PoolingAllocationConfig;

use crate::state::HostState;

/// Counters for the on-disk compile cache, for observability and tests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStats {
    /// Loads served from a `.cwasm` on disk (no compilation).
    pub hits: u64,
    /// Loads that had to compile (no usable `.cwasm`).
    pub misses: u64,
    /// `.cwasm` artifacts written to disk.
    pub writes: u64,
    /// Disk-cache read/deserialize failures that fell back to compiling.
    pub errors: u64,
}

/// An on-disk cache of precompiled modules (`.cwasm`), keyed by the wasm
/// bytes' content hash and the engine configuration's fingerprint.
///
/// # Trust boundary
///
/// Deserializing a `.cwasm` is `unsafe` in wasmtime: the artifact is trusted
/// to have been produced by a compatible engine, and a hostile artifact could
/// cause undefined behaviour. **The cache directory must therefore be one only
/// the host can write** (the same assumption any build cache makes). Artifacts
/// are written atomically (temp file + rename) so a crash cannot leave a
/// half-written file in place.
struct DiskCache {
    dir: PathBuf,
    /// Fingerprint of the engine configuration. Any change (allocation
    /// strategy, enabled features) yields a different fingerprint, so stale
    /// artifacts are never deserialized.
    engine_key: u64,
    stats: Mutex<CacheStats>,
}

impl DiskCache {
    fn new(dir: PathBuf, engine_key: u64) -> Result<Self> {
        std::fs::create_dir_all(&dir).map_err(|e| {
            anyhow::anyhow!("creating compile-cache dir {}: {e}", dir.display())
        })?;
        Ok(Self {
            dir,
            engine_key,
            stats: Mutex::new(CacheStats::default()),
        })
    }

    /// `<dir>/<content>-<engine>.cwasm`
    fn path_for(&self, content: u64) -> PathBuf {
        self.dir.join(format!("{content:016x}-{:016x}.cwasm", self.engine_key))
    }

    fn get(&self, content: u64, engine: &Engine) -> Option<Module> {
        let path = self.path_for(content);
        if !path.exists() {
            return None;
        }
        // SAFETY: the file is one we wrote, named by content + engine hash.
        match unsafe { Module::deserialize_file(engine, &path) } {
            Ok(module) => {
                self.stats.lock().unwrap().hits += 1;
                Some(module)
            }
            Err(_) => {
                // Corrupt or stale artifact: drop it and recompile below.
                let _ = std::fs::remove_file(&path);
                self.stats.lock().unwrap().errors += 1;
                None
            }
        }
    }

    fn put(&self, content: u64, module: &Module) {
        let bytes = match module.serialize() {
            Ok(bytes) => bytes,
            Err(_) => return,
        };
        let path = self.path_for(content);
        // Atomic publish: write a sibling temp file, then rename over the
        // target. A crash mid-write cannot leave a truncated `.cwasm`.
        let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
        if std::fs::write(&tmp, &bytes).is_ok() && std::fs::rename(&tmp, &path).is_ok() {
            self.stats.lock().unwrap().writes += 1;
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// Stable 64-bit FNV-1a — a dependency-free content fingerprint. Not
/// cryptographic, but the cache key only needs collision resistance against
/// accidental collisions, not a hostile adversary.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Fingerprint the engine configuration: the wasmtime compatibility hash plus
/// our own allocation strategy (which the compatibility hash does not cover).
fn engine_fingerprint(engine: &Engine, strategy: &AllocationStrategy) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    engine.precompile_compatibility_hash().hash(&mut hasher);
    format!("{strategy:?}").hash(&mut hasher);
    hasher.finish()
}

/// How the engine allocates instance resources.
#[derive(Debug, Clone)]
pub enum AllocationStrategy {
    /// Allocate memory per instance (wasmtime default).
    OnDemand,
    /// Reserve a fixed pool of instance slots up front. Predictable latency and
    /// better behaviour under load/churn; costs the pool's memory whether or not
    /// it is used.
    Pooled {
        /// Maximum number of simultaneously live instances.
        max_instances: u32,
        /// Bytes of each instance's linear memory kept resident (committed)
        /// rather than merely reserved as address space.
        memory_per_instance: usize,
        /// Largest linear memory a module may declare/be implied to have
        /// (bytes). Modules declaring no maximum are treated as needing 4 GiB;
        /// keep this at 4 GiB unless every plugin declares a smaller max.
        max_memory_bytes: usize,
        /// Maximum tables per instance.
        max_tables_per_module: u32,
    },
}

impl AllocationStrategy {
    /// A sane pooled config: 256 instance slots, 64 MiB of each instance's
    /// memory kept resident (the rest is reserved virtual address space, only
    /// committed as the guest touches it).
    ///
    /// Note `max_memory_bytes` defaults to 4 GiB because modules built without
    /// an explicit `memory` maximum are *implied* to be allowed up to 4 GiB —
    /// the pooling allocator rejects anything larger than it is configured for,
    /// and it also rejects modules whose implied max exceeds the configured
    /// max, so leaving headroom here is what lets ordinary Rust/Go modules load.
    pub fn pooled_default() -> Self {
        AllocationStrategy::Pooled {
            max_instances: 256,
            memory_per_instance: 64 << 20,
            max_memory_bytes: 4 << 30,
            max_tables_per_module: 4,
        }
    }
}

pub struct Runtime {
    engine: Engine,
    linker: Linker<HostState>,
    strategy: AllocationStrategy,
    /// In-process module cache keyed by canonical path (+ mtime), so a rebuilt
    /// wasm at the same path is recompiled rather than served stale.
    modules: Mutex<HashMap<PathBuf, (u128, Module)>>,
    /// Optional on-disk `.cwasm` cache; `None` disables it entirely.
    disk_cache: Option<DiskCache>,
}

impl Runtime {
    /// Build a runtime with the default on-demand allocation strategy.
    pub fn new() -> Result<Self> {
        Self::with_strategy(AllocationStrategy::OnDemand)
    }

    /// Build a runtime with an explicit allocation strategy.
    pub fn with_strategy(strategy: AllocationStrategy) -> Result<Self> {
        let mut config = wasmtime::Config::new();
        config.wasm_backtrace_details(wasmtime::WasmBacktraceDetails::Enable);

        if let AllocationStrategy::Pooled {
            max_instances,
            memory_per_instance,
            max_memory_bytes,
            max_tables_per_module,
        } = &strategy
        {
            let mut pool = PoolingAllocationConfig::new();
            pool.total_memories(*max_instances);
            pool.total_stacks(*max_instances);
            pool.total_tables(max_instances.saturating_mul(*max_tables_per_module));
            // This is the *maximum the module may have*, not a reservation. A
            // module with no declared max is implied to need 4 GiB, so this must
            // be at least that or instantiation is rejected.
            pool.max_memory_size(*max_memory_bytes);
            pool.total_core_instances(*max_instances);
            // This bounds the *resident* memory actually committed per instance.
            pool.linear_memory_keep_resident(*memory_per_instance);
            pool.max_unused_warm_slots(*max_instances);
            config.allocation_strategy(wasmtime::InstanceAllocationStrategy::Pooling(pool));
        }

        let engine = Engine::new(&config)?;

        let mut linker: Linker<HostState> = Linker::new(&engine);
        wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |s: &mut HostState| &mut s.wasi)
            .map_err(|e| anyhow::anyhow!("adding WASI p1 to linker: {e}"))?;
        linker.func_wrap("host", "log", host_log)?;
        linker.func_wrap("host", "now_ms", || -> i64 { now_ms() })?;
        // Config access: read the current config (JSON) into a guest buffer, and
        // a monotonic version so the guest can cheaply detect changes.
        linker.func_wrap("host", "get_config", host_get_config)?;
        linker.func_wrap("host", "config_version", |caller: wasmtime::Caller<'_, HostState>| -> i64 {
            caller
                .data()
                .config_version
                .load(std::sync::atomic::Ordering::SeqCst)
        })?;
        // Cross-plugin service calls. A plugin invokes another plugin's `op` by
        // *service name* (not slot), so it depends on the capability rather than
        // a specific implementation. See `service::Shared::call_service`.
        linker.func_wrap("host", "call_service", host_call_service)?;
        // Is a service currently provided? Lets a plugin check before calling.
        linker.func_wrap("host", "has_service", host_has_service)?;

        Ok(Self {
            engine,
            linker,
            strategy,
            modules: Mutex::new(HashMap::new()),
            disk_cache: None,
        })
    }

    /// Build a runtime that also caches precompiled modules on disk.
    ///
    /// Cold start with a warm cache is a `deserialize_file` (milliseconds)
    /// instead of a full compile (tens to hundreds of ms per plugin). The
    /// directory must be writable by the host and **not** by untrusted code
    /// (see [`CacheStats`] for the trust note).
    pub fn with_disk_cache(strategy: AllocationStrategy, cache_dir: impl Into<PathBuf>) -> Result<Self> {
        let mut rt = Self::with_strategy(strategy)?;
        let key = engine_fingerprint(&rt.engine, &rt.strategy);
        rt.disk_cache = Some(DiskCache::new(cache_dir.into(), key)?);
        Ok(rt)
    }

    /// The default on-demand strategy plus a disk cache.
    pub fn new_cached(cache_dir: impl Into<PathBuf>) -> Result<Self> {
        Self::with_disk_cache(AllocationStrategy::OnDemand, cache_dir)
    }

    /// Is a disk cache configured?
    pub fn disk_cache_enabled(&self) -> bool {
        self.disk_cache.is_some()
    }

    /// Snapshot of the disk cache counters (all zero when disabled).
    pub fn cache_stats(&self) -> CacheStats {
        self.disk_cache
            .as_ref()
            .map(|c| *c.stats.lock().unwrap())
            .unwrap_or_default()
    }

    pub fn allocation_strategy(&self) -> &AllocationStrategy {
        &self.strategy
    }

    /// Human-readable name of the active strategy.
    pub fn strategy_name(&self) -> &'static str {
        match self.strategy {
            AllocationStrategy::OnDemand => "on-demand",
            AllocationStrategy::Pooled { .. } => "pooled",
        }
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// Compile (or fetch from cache) a module. The cache key includes the
    /// file's mtime, so overwriting a `.wasm` (a rebuild) forces recompilation.
    ///
    /// When a disk cache is configured, a miss compiles once and writes a
    /// `.cwasm`; a later *process* then deserializes it instead of recompiling.
    pub fn compile(&self, engine: &Engine, path: &Path) -> Result<Module> {
        let key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let mtime = std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        {
            let cache = self.modules.lock().unwrap();
            if let Some((cached_mtime, m)) = cache.get(&key) {
                if *cached_mtime == mtime {
                    return Ok(m.clone());
                }
            }
        }

        // Read the module bytes once: the content hash keys the disk cache, and
        // `Module::new` compiles from the same bytes on a miss.
        let bytes = std::fs::read(path)
            .map_err(|e| anyhow::anyhow!("reading wasm module {}: {e}", path.display()))?;

        let module = if let Some(disk) = &self.disk_cache {
            let content = fnv1a(&bytes);
            match disk.get(content, engine) {
                Some(module) => module,
                None => {
                    let module = Module::new(engine, &bytes)
                        .map_err(|e| anyhow::anyhow!("compiling wasm module {}: {e}", path.display()))?;
                    disk.put(content, &module);
                    disk.stats.lock().unwrap().misses += 1;
                    module
                }
            }
        } else {
            Module::new(engine, &bytes)
                .map_err(|e| anyhow::anyhow!("compiling wasm module {}: {e}", path.display()))?
        };

        self.modules.lock().unwrap().insert(key, (mtime, module.clone()));
        Ok(module)
    }

    /// Drop every cached module. Used by the `refresh` command.
    pub fn clear_cache(&self) {
        self.modules.lock().unwrap().clear();
    }

    /// Delete every `.cwasm` artifact in the disk cache, if configured.
    /// Returns the number of files removed. The in-process cache is left
    /// alone; call [`Runtime::clear_cache`] as well for a full reset.
    pub fn clear_disk_cache(&self) -> Result<usize> {
        let Some(disk) = &self.disk_cache else {
            return Ok(0);
        };
        let mut removed = 0;
        for entry in std::fs::read_dir(&disk.dir)
            .map_err(|e| anyhow::anyhow!("reading compile-cache dir {}: {e}", disk.dir.display()))?
        {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("cwasm")
                && std::fs::remove_file(&path).is_ok()
            {
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// Instantiate under the shared linker (WASI + `host.*` imports).
    pub fn instantiate(&self, store: &mut Store<HostState>, module: &Module) -> Result<Instance> {
        let instance = self
            .linker
            .instantiate(&mut *store, module)
            .map_err(|e| anyhow::anyhow!("instantiating module: {e}"))?;

        // WASI *reactor* modules (Go, and `--target wasm32-wasip1` libs that
        // want it) export `_initialize`; it must run once before any other
        // export is called. Command modules (which export `_start`) do not
        // have it, so this is a no-op for them.
        if let Ok(init) = instance.get_typed_func::<(), ()>(&mut *store, "_initialize") {
            init.call(&mut *store, ())
                .map_err(|e| anyhow::anyhow!("_initialize failed: {e}"))?;
        }
        Ok(instance)
    }
}

fn host_log(mut caller: wasmtime::Caller<'_, HostState>, level: i32, ptr: i32, len: i32) -> wasmtime::Result<()> {
    let mem = caller
        .get_export("memory")
        .and_then(|e| e.into_memory())
        .ok_or_else(|| wasmtime::Error::msg("`host.log` called but no `memory` export"))?;
    let mut buf = vec![0u8; len.max(0) as usize];
    mem.read(&caller, ptr as usize, &mut buf)?;
    let message = String::from_utf8_lossy(&buf).into_owned();

    let (log, slot, plugin) = {
        let d = caller.data();
        (d.log.clone(), d.slot.clone(), d.plugin_name.clone())
    };
    // `push` assigns the sequence number and handles stderr echo + hook.
    log.push(crate::state::LogRecord {
        seq: 0,
        slot,
        plugin,
        level: crate::state::LogLevel::from_i32(level),
        message,
    });
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `host.get_config(out_ptr, cap) -> i64`
///
/// Writes the plugin's current config as UTF-8 JSON into guest memory. Returns
/// the number of bytes written, or `-(needed)` if `cap` was too small (the
/// guest can then re-allocate and retry). Returns `0` when the config is JSON
/// `null` (i.e. unset), which the guest should treat as "no config".
fn host_get_config(
    mut caller: wasmtime::Caller<'_, HostState>,
    out_ptr: i32,
    cap: i32,
) -> wasmtime::Result<i64> {
    let cfg = caller.data().config.lock().unwrap().clone();
    if cfg.is_null() {
        return Ok(0);
    }
    let bytes = serde_json::to_vec(&cfg)
        .map_err(|e| wasmtime::Error::msg(format!("serializing config: {e}")))?;

    if out_ptr == 0 || bytes.len() > cap.max(0) as usize {
        return Ok(-(bytes.len() as i64));
    }
    let mem = caller
        .get_export("memory")
        .and_then(|e| e.into_memory())
        .ok_or_else(|| wasmtime::Error::msg("`host.get_config` called but no `memory` export"))?;
    mem.write(&mut caller, out_ptr as usize, &bytes)?;
    Ok(bytes.len() as i64)
}

/// `host.has_service(name_ptr, name_len) -> i32` — 1 if a provider is registered
/// for that service, 0 otherwise. Lets a plugin check before calling, so an
/// optional dependency does not have to be a hard `inject`.
fn host_has_service(
    mut caller: wasmtime::Caller<'_, HostState>,
    name_ptr: i32,
    name_len: i32,
) -> wasmtime::Result<i32> {
    let name = {
        let mem = caller
            .get_export("memory")
            .and_then(|e| e.into_memory())
            .ok_or_else(|| wasmtime::Error::msg("`host.has_service` needs a `memory` export"))?;
        let mut buf = vec![0u8; name_len.max(0) as usize];
        mem.read(&caller, name_ptr as usize, &mut buf)?;
        String::from_utf8_lossy(&buf).into_owned()
    };
    let has = caller
        .data()
        .services
        .as_ref()
        .and_then(|s| s.provider(&name))
        .is_some();
    Ok(i32::from(has))
}

/// `host.call_service(svc_ptr, svc_len, op_ptr, op_len, args_ptr, args_len, out_ptr, out_cap) -> i64`
///
/// Calls `op` on the plugin providing `service`, passing JSON `args`, and writes
/// the JSON reply into the guest's `out` buffer. Return convention matches the
/// other out-buffer calls: bytes written, or `-(needed)` if `out_cap` is too
/// small. An error (no provider, busy/recursive, or a guest trap in the callee)
/// is reported as a JSON `{"kind":"error", ...}` reply rather than a trap, so a
/// plugin can handle a missing dependency gracefully.
fn host_call_service(
    mut caller: wasmtime::Caller<'_, HostState>,
    svc_ptr: i32,
    svc_len: i32,
    op_ptr: i32,
    op_len: i32,
    args_ptr: i32,
    args_len: i32,
    out_ptr: i32,
    out_cap: i32,
) -> wasmtime::Result<i64> {
    let (svc, op, args_json) = {
        let mem = caller
            .get_export("memory")
            .and_then(|e| e.into_memory())
            .ok_or_else(|| wasmtime::Error::msg("`host.call_service` needs a `memory` export"))?;
        let read = |ptr: i32, len: i32| -> wasmtime::Result<String> {
            let mut buf = vec![0u8; len.max(0) as usize];
            mem.read(&caller, ptr as usize, &mut buf)?;
            Ok(String::from_utf8_lossy(&buf).into_owned())
        };
        (read(svc_ptr, svc_len)?, read(op_ptr, op_len)?, read(args_ptr, args_len)?)
    };

    // Call OUTSIDE any store borrow: the callee is a different instance.
    let result: serde_json::Value = {
        let services = caller.data().services.clone();
        let args: serde_json::Value = serde_json::from_str(&args_json)
            .unwrap_or(serde_json::Value::Null);
        match services {
            Some(shared) => match shared.call_service(&svc, &op, &args) {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "kind": "error", "message": e.to_string() }),
            },
            None => serde_json::json!({
                "kind": "error",
                "message": "service calls are not enabled in this host",
            }),
        }
    };

    let bytes = serde_json::to_vec(&result)
        .map_err(|e| wasmtime::Error::msg(format!("serializing service reply: {e}")))?;
    if out_ptr == 0 || bytes.len() > out_cap.max(0) as usize {
        return Ok(-(bytes.len() as i64));
    }
    let mem = caller
        .get_export("memory")
        .and_then(|e| e.into_memory())
        .ok_or_else(|| wasmtime::Error::msg("`host.call_service` needs a `memory` export"))?;
    mem.write(&mut caller, out_ptr as usize, &bytes)?;
    Ok(bytes.len() as i64)
}
