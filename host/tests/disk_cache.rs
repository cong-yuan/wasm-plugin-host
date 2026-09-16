//! Disk compile-cache (P2): a warm cache turns a cold compile into a
//! deserialize, and a changed engine configuration invalidates it.
//!
//! Plugins are tiny WAT modules, so the suite is hermetic.

use std::path::{Path, PathBuf};

use wasm_plugin_host::{AllocationStrategy, CacheStats, Registry, Runtime};

const RESULT_JSON: &str = r#"{"kind":"success","content":"ok","value":{}}"#;

/// A minimal ABI-v1 module declaring one tool, reused from the reload suite's
/// shape but kept local so this file is self-contained.
fn wasm_bytes(slot: &str) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{slot}_tool","description":"t","exec":"go"}}]}}"#
    );
    let decl_off = 16usize;
    let res_off = decl_off + decl.len();
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 4096))
          (data (i32.const {decl_off}) {decl:?})
          (data (i32.const {res_off}) {res:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n)))
            (local.get $p))
          (func (export "plugin_free") (param $p i32) (param $n i32)
            (global.set $bump (local.get $p)))
          (func $blit (param $src i32) (param $len i32) (param $out i32) (param $cap i32) (result i64)
            (local $i i32)
            (if (i32.lt_s (local.get $cap) (local.get $len))
              (then (return (i64.extend_i32_s (i32.sub (i32.const 0) (local.get $len))))))
            (block $done (loop $loop
              (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
              (i32.store8
                (i32.add (local.get $out) (local.get $i))
                (i32.load8_u (i32.add (local.get $src) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $loop)))
            (i64.extend_i32_s (local.get $len)))
          (func (export "plugin_describe") (param $out i32) (param $cap i32) (result i64)
            (call $blit (i32.const {decl_off}) (i32.const {decl_len}) (local.get $out) (local.get $cap)))
          (func (export "plugin_invoke")
            (param i32 i32 i32 i32) (param $out i32) (param $cap i32) (result i64)
            (call $blit (i32.const {res_off}) (i32.const {res_len}) (local.get $out) (local.get $cap)))
        )"#,
        decl_off = decl_off,
        res_off = res_off,
        decl = decl,
        res = RESULT_JSON,
        decl_len = decl.len(),
        res_len = RESULT_JSON.len(),
    );
    wat::parse_str(&wat).expect("test wat should parse")
}

fn tmpdir(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("wph-cache-{}-{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn write(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
}

/// Count `.cwasm` artifacts sitting in a directory.
fn cwasm_count(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("cwasm"))
                .count()
        })
        .unwrap_or(0)
}

#[test]
fn cold_compile_writes_a_cwasm_and_warms_on_second_load() {
    let work = tmpdir("roundtrip");
    let cache = work.join("cache");
    let wasm = work.join("p.wasm");
    write(&wasm, &wasm_bytes("alpha"));

    // First run: compiles, then writes the artifact.
    {
        let rt = Runtime::new_cached(&cache).unwrap();
        assert!(rt.disk_cache_enabled());
        let mut reg = Registry::new(rt);
        reg.load("slot", &wasm, serde_json::Value::Null).unwrap();
        let stats = reg.runtime().cache_stats();
        assert_eq!(stats.misses, 1, "first load must compile");
        assert_eq!(stats.writes, 1, "first load must write a .cwasm");
        assert_eq!(stats.hits, 0);
        reg.unload("slot").unwrap();
    }

    assert_eq!(cwasm_count(&cache), 1, "one artifact on disk");

    // Second run (fresh process equivalent): serves from disk, no compile.
    {
        let rt = Runtime::new_cached(&cache).unwrap();
        let mut reg = Registry::new(rt);
        reg.load("slot", &wasm, serde_json::Value::Null).unwrap();
        let stats = reg.runtime().cache_stats();
        assert_eq!(stats.hits, 1, "second load must come from disk");
        assert_eq!(stats.misses, 0, "second load must not compile");
        // Still callable.
        let out = reg.call_tool("alpha_tool", &serde_json::json!({})).unwrap();
        assert_eq!(out["kind"], "success");
    }
}

#[test]
fn engine_change_invalidates_the_disk_cache() {
    let work = tmpdir("invalidated");
    let cache = work.join("cache");
    let wasm = work.join("p.wasm");
    write(&wasm, &wasm_bytes("beta"));

    // Compile with the default (on-demand) engine: writes one artifact.
    {
        let rt = Runtime::new_cached(&cache).unwrap();
        let mut reg = Registry::new(rt);
        reg.load("slot", &wasm, serde_json::Value::Null).unwrap();
        assert_eq!(reg.runtime().cache_stats().writes, 1);
    }

    // A different allocation strategy has a different engine fingerprint, so
    // the previous artifact must NOT be used — it recompiles and writes a
    // second, distinct artifact.
    {
        let rt = Runtime::with_disk_cache(AllocationStrategy::pooled_default(), &cache).unwrap();
        let mut reg = Registry::new(rt);
        reg.load("slot", &wasm, serde_json::Value::Null).unwrap();
        let stats = reg.runtime().cache_stats();
        assert_eq!(stats.hits, 0, "artifact from a different engine must not be reused");
        assert_eq!(stats.misses, 1, "must recompile under the new engine");
        assert_eq!(stats.writes, 1);
    }

    assert_eq!(
        cwasm_count(&cache),
        2,
        "two engine configs => two artifacts, keyed by fingerprint"
    );
}

#[test]
fn corrupted_artifact_is_dropped_and_recompiled() {
    let work = tmpdir("corrupt");
    let cache = work.join("cache");
    let wasm = work.join("p.wasm");
    write(&wasm, &wasm_bytes("gamma"));

    {
        let rt = Runtime::new_cached(&cache).unwrap();
        let mut reg = Registry::new(rt);
        reg.load("slot", &wasm, serde_json::Value::Null).unwrap();
    }

    // Overwrite the artifact with garbage.
    let artifact = std::fs::read_dir(&cache)
        .unwrap()
        .filter_map(|e| e.ok())
        .find(|e| e.path().extension().and_then(|x| x.to_str()) == Some("cwasm"))
        .expect("one artifact")
        .path();
    write(&artifact, b"not a valid cwasm");

    // Load must recover by recompiling, not fail.
    let rt = Runtime::new_cached(&cache).unwrap();
    let mut reg = Registry::new(rt);
    reg.load("slot", &wasm, serde_json::Value::Null)
        .expect("a corrupt artifact must not break loading");
    let stats = reg.runtime().cache_stats();
    assert_eq!(stats.errors, 1, "the bad artifact is recorded as an error");
    assert_eq!(stats.misses, 1, "and it falls back to compiling");
    assert_eq!(stats.writes, 1, "rewriting a good artifact");
}

#[test]
fn rebuild_at_the_same_path_recompiles_even_with_a_warm_disk_cache() {
    let work = tmpdir("rebuild");
    let cache = work.join("cache");
    let wasm = work.join("p.wasm");
    write(&wasm, &wasm_bytes("alpha"));

    {
        let rt = Runtime::new_cached(&cache).unwrap();
        let mut reg = Registry::new(rt);
        reg.load("slot", &wasm, serde_json::Value::Null).unwrap();
    }

    // Same path, different bytes => different content hash => fresh artifact,
    // and the tool surface reflects the new build.
    write(&wasm, &wasm_bytes("delta"));
    let rt = Runtime::new_cached(&cache).unwrap();
    let mut reg = Registry::new(rt);
    let report = reg.load("slot", &wasm, serde_json::Value::Null).unwrap();
    assert_eq!(report.tools, vec!["delta_tool"]);
    assert_eq!(cwasm_count(&cache), 2, "content hash keys the artifact");
}

#[test]
fn clearing_the_disk_cache_removes_artifacts() {
    let work = tmpdir("clear");
    let cache = work.join("cache");
    let wasm = work.join("p.wasm");
    write(&wasm, &wasm_bytes("alpha"));

    let rt = Runtime::new_cached(&cache).unwrap();
    let mut reg = Registry::new(rt);
    reg.load("slot", &wasm, serde_json::Value::Null).unwrap();
    assert_eq!(cwasm_count(&cache), 1);

    let removed = reg.runtime().clear_disk_cache().unwrap();
    assert_eq!(removed, 1);
    assert_eq!(cwasm_count(&cache), 0);
}

#[test]
fn disk_cache_is_off_by_default() {
    let rt = Runtime::new().unwrap();
    assert!(!rt.disk_cache_enabled());
    assert_eq!(rt.cache_stats(), CacheStats::default());
    // clear_disk_cache on a cache-less runtime is a no-op, not an error.
    assert_eq!(rt.clear_disk_cache().unwrap(), 0);
}

#[test]
fn cache_dir_is_created_if_absent() {
    let work = tmpdir("mkdir");
    let cache = work.join("deeply").join("nested").join("cache");
    assert!(!cache.exists());
    let rt = Runtime::new_cached(&cache).unwrap();
    assert!(rt.disk_cache_enabled());
    assert!(cache.is_dir(), "the cache dir must be created on demand");
}

#[test]
fn a_hot_reload_re_uses_the_cache_for_an_unchanged_file() {
    let work = tmpdir("reload-cache");
    let cache = work.join("cache");
    let wasm = work.join("p.wasm");
    write(&wasm, &wasm_bytes("alpha"));

    let rt = Runtime::new_cached(&cache).unwrap();
    let mut reg = Registry::new(rt);
    reg.load("slot", &wasm, serde_json::Value::Null).unwrap();

    // A reload of an *unchanged* file hits the in-process cache first, so the
    // disk cache is not consulted again — confirming the two layers compose.
    let before = reg.runtime().cache_stats();
    reg.reload("slot", &wasm, None).unwrap();
    let after = reg.runtime().cache_stats();
    assert_eq!(before.hits, after.hits, "no extra disk hit for an unchanged file");
}

#[test]
fn concurrent_compiles_of_the_same_plugin_leave_a_readable_artifact() {
    // STRESS TEST, not a guaranteed regression guard. It exercises concurrent
    // writes to one cache dir and asserts the published artifact is always
    // valid, but it does NOT reliably reproduce the specific hazard the unique
    // temp-name fix targets: with a process-id-only temp name, corruption needs
    // thread B to `open` the temp file *before* thread A's `rename` publishes it
    // and to `write` *after* — a window `std::fs::write` makes very narrow, so
    // this test passes even against the unfixed code. The fix is justified by
    // that interleaving analysis, and pinned by the leftover-temp assertion
    // below, which IS deterministic.
    let work = tmpdir("concurrent");
    let cache = work.join("cache");
    let wasm = work.join("p.wasm");
    write(&wasm, &wasm_bytes("alpha"));

    let threads: Vec<_> = (0..8)
        .map(|_| {
            let wasm = wasm.clone();
            let cache = cache.clone();
            std::thread::spawn(move || {
                // Each thread has its own runtime (and thus its own in-process
                // cache) but they share the on-disk cache directory.
                let rt = Runtime::new_cached(&cache).unwrap();
                let mut reg = Registry::new(rt);
                reg.load("slot", &wasm, serde_json::Value::Null).unwrap();
            })
        })
        .collect();
    for t in threads {
        t.join().expect("compile thread must not panic");
    }

    // Whatever interleaving happened, a fresh load must deserialize cleanly
    // from disk (no error fallback) — i.e. the published artifact is intact.
    let rt = Runtime::new_cached(&cache).unwrap();
    let mut reg = Registry::new(rt);
    reg.load("slot", &wasm, serde_json::Value::Null).unwrap();
    let stats = reg.runtime().cache_stats();
    assert_eq!(stats.errors, 0, "no corrupt artifact should have been published");
    assert_eq!(stats.hits, 1, "the published artifact must be reusable");

    // Deterministic invariant: every temp file was renamed away (or cleaned up
    // on failure). A stranded temp file would mean the publish path leaked.
    let leftovers: Vec<_> = std::fs::read_dir(&cache)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .contains(".tmp-")
        })
        .collect();
    assert!(
        leftovers.is_empty(),
        "atomic publish must not leave temp files behind: {leftovers:?}"
    );
}
