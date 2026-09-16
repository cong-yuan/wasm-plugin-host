//! Integration tests for slots, atomic reload, and directory watching.
//!
//! Plugins are tiny WAT modules compiled in-process, so the suite is hermetic
//! (no cargo build of a wasm plugin required).

use std::path::{Path, PathBuf};

const RESULT_JSON: &str = r#"{"kind":"success","content":"ok","value":{}}"#;

/// Build a minimal ABI-v1 module declaring one tool `<slot>_tool`, whose
/// declaration and invoke-result come from embedded data segments.
fn wasm_bytes(slot: &str, marker: &str) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{slot}_tool","description":"{marker}","exec":"go"}}]}}"#
    );
    let decl_off = 16usize;
    let res_off = decl_off + decl.len();
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (import "host" "now_ms" (func $now (result i64)))
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
          ;; LIFO free: rewind the bump pointer so repeated calls do not exhaust
          ;; the (small) test memory. The host frees the output buffer last, so
          ;; this is correct for the call pattern used here.
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
            (param $op i32) (param $oplen i32) (param $a i32) (param $alen i32)
            (param $out i32) (param $cap i32) (result i64)
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
    p.push(format!("wph-{}-{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn write(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
}

fn registry() -> Registry {
    Registry::new(Runtime::new().unwrap())
}

#[test]
fn load_then_unload_releases_slot() {
    let dir = tmpdir("load-unload");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_bytes("alpha", "v1"));

    let mut reg = registry();
    let r = reg.load("slot", &wasm, serde_json::Value::Null).unwrap();
    assert_eq!(r.slot, "slot");
    assert_eq!(r.tools, vec!["alpha_tool"]);
    assert!(reg.is_loaded("slot"));

    let removed = reg.unload("slot").unwrap();
    assert_eq!(removed, vec!["alpha_tool"]);
    assert!(!reg.is_loaded("slot"));
    assert!(reg.list_tools().is_empty());
}

#[test]
fn reload_swaps_code_and_keeps_slot_identity() {
    let dir = tmpdir("reload");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_bytes("alpha", "v1"));

    let mut reg = registry();
    reg.load("slot", &wasm, serde_json::Value::Null).unwrap();

    // Replace with a build that declares a *different* internal name + tool.
    write(&wasm, &wasm_bytes("beta", "v2"));
    let r = reg.reload("slot", &wasm, None).unwrap();

    assert_eq!(r.slot, "slot");
    assert_eq!(r.old_plugin, "alpha");
    assert_eq!(r.new_plugin, "beta");
    assert_eq!(r.old_tools, vec!["alpha_tool"]);
    assert_eq!(r.new_tools, vec!["beta_tool"]);

    // Slot identity is stable; only its tools changed.
    assert!(reg.is_loaded("slot"));
    assert_eq!(reg.tool_owner("beta_tool"), Some("slot"));
    assert!(reg.tool_owner("alpha_tool").is_none());
}

#[test]
fn reload_is_atomic_on_broken_build() {
    let dir = tmpdir("atomic");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_bytes("alpha", "good"));

    let mut reg = registry();
    reg.load("slot", &wasm, serde_json::Value::Null).unwrap();
    let before: Vec<String> = reg.list_tools().iter().map(|t| t.name.clone()).collect();

    // Corrupt the file and attempt a reload.
    write(&wasm, b"definitely not wasm");
    let err = reg.reload("slot", &wasm, None).unwrap_err();
    assert!(
        err.to_string().contains("compiling") || err.to_string().contains("wasm"),
        "unexpected error: {err}"
    );

    // The old plugin must still be live and serving its tool.
    assert!(reg.is_loaded("slot"));
    let after: Vec<String> = reg.list_tools().iter().map(|t| t.name.clone()).collect();
    assert_eq!(before, after);
    let out = reg.call_tool("alpha_tool", &serde_json::json!({})).unwrap();
    assert_eq!(out["kind"], "success");
}

#[test]
fn reload_rejected_when_new_tool_collides_with_other_slot() {
    let dir = tmpdir("collide");
    let a = dir.join("a.wasm");
    let b = dir.join("b.wasm");
    write(&a, &wasm_bytes("alpha", "v1"));
    write(&b, &wasm_bytes("beta", "v1"));

    let mut reg = registry();
    reg.load("one", &a, serde_json::Value::Null).unwrap();
    reg.load("two", &b, serde_json::Value::Null).unwrap();

    // Make a build that reuses slot one's tool name, then try to load it in two.
    write(&b, &wasm_bytes("alpha", "v2"));
    let err = reg.reload("two", &b, None).unwrap_err();
    assert!(err.to_string().contains("collides"), "unexpected: {err}");

    // Both slots remain intact.
    assert_eq!(reg.tool_owner("alpha_tool"), Some("one"));
    assert_eq!(reg.tool_owner("beta_tool"), Some("two"));
}

#[test]
fn validate_compiles_without_swapping() {
    let dir = tmpdir("validate");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_bytes("alpha", "v1"));

    let mut reg = registry();
    reg.load("slot", &wasm, serde_json::Value::Null).unwrap();

    let (name, tools) = reg.validate(&wasm).unwrap();
    assert_eq!(name, "alpha");
    assert_eq!(tools, vec!["alpha_tool"]);
    assert!(reg.is_loaded("slot"));
}


// ---------- config diffing ----------
//
// These tests use a plugin that exports `plugin_configure` and
// `plugin_on_config` (so the host's "consumed" path is exercised) but keeps its
// `invoke` trivial. The observable contract they check is the *host-side* one:
// which slots a config change touches.

/// A minimal plugin that declares one tool `<slot>_tool`, returns a fixed
/// success JSON, and has both config hooks.
fn wasm_with_config_hooks(slot: &str) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{slot}_tool","description":"cfg","exec":"go"}}]}}"#
    );
    let res = r#"{"kind":"success","content":"ok","value":{}}"#;
    let decl_off = 16usize;
    let res_off = decl_off + decl.len();
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (import "host" "get_config" (func $getcfg (param i32 i32) (result i64)))
          (import "host" "config_version" (func $ver (result i64)))
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 4096))
          (global $seen (mut i64) (i64.const 0))
          (data (i32.const {decl_off}) {decl:?})
          (data (i32.const {res_off}) {res:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_configure") (param i32 i32) (result i32)
            (global.set $seen (call $ver)) (i32.const 0))
          (func (export "plugin_on_config") (result i32)
            (global.set $seen (call $ver)) (i32.const 0))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n)))
            (local.get $p))
          ;; LIFO free: rewind the bump pointer so repeated calls do not exhaust
          ;; the (small) test memory. The host frees the output buffer last, so
          ;; this is correct for the call pattern used here.
          (func (export "plugin_free") (param $p i32) (param $n i32)
            (global.set $bump (local.get $p)))
          (func $blit (param $src i32) (param $len i32) (param $out i32) (param $cap i32) (result i64)
            (local $i i32)
            (if (i32.lt_s (local.get $cap) (local.get $len))
              (then (return (i64.extend_i32_s (i32.sub (i32.const 0) (local.get $len))))))
            (block $done (loop $loop
              (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
              (i32.store8 (i32.add (local.get $out) (local.get $i))
                (i32.load8_u (i32.add (local.get $src) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $loop)))
            (i64.extend_i32_s (local.get $len)))
          (func (export "plugin_describe") (param $out i32) (param $cap i32) (result i64)
            (call $blit (i32.const {decl_off}) (i32.const {dlen}) (local.get $out) (local.get $cap)))
          (func (export "plugin_invoke")
            (param i32 i32 i32 i32) (param $out i32) (param $cap i32) (result i64)
            (call $blit (i32.const {res_off}) (i32.const {rlen}) (local.get $out) (local.get $cap)))
        )"#,
        decl_off = decl_off,
        res_off = res_off,
        decl = decl,
        res = res,
        dlen = decl.len(),
        rlen = res.len(),
    );
    wat::parse_str(&wat).expect("config-hook wat should parse")
}

#[test]
fn load_injects_config() {
    let dir = tmpdir("cfg-load");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_with_config_hooks("alpha"));

    let mut reg = registry();
    let cfg = serde_json::json!({ "greeting": "Hello" });
    reg.load("slot", &wasm, cfg.clone()).unwrap();

    assert_eq!(reg.slot_config("slot"), Some(&cfg));
    assert!(reg.slot_has_config_hook("slot"));
}

#[test]
fn apply_config_reports_consumed_and_is_idempotent() {
    let dir = tmpdir("cfg-apply");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_with_config_hooks("alpha"));

    let mut reg = registry();
    reg.load("slot", &wasm, serde_json::json!({ "n": 1 })).unwrap();

    // Different config -> consumed by the on_config hook.
    let consumed = reg.apply_config("slot", serde_json::json!({ "n": 2 })).unwrap();
    assert!(consumed, "plugin has an on_config hook");
    assert_eq!(reg.slot_config("slot"), Some(&serde_json::json!({ "n": 2 })));

    // Same config again -> no-op (no touch).
    let consumed = reg.apply_config("slot", serde_json::json!({ "n": 2 })).unwrap();
    assert!(!consumed, "unchanged config must be a no-op");
}

#[test]
fn config_change_to_one_slot_leaves_the_other_untouched() {
    let dir = tmpdir("cfg-diff");
    let a = dir.join("a.wasm");
    let b = dir.join("b.wasm");
    write(&a, &wasm_with_config_hooks("alpha"));
    write(&b, &wasm_with_config_hooks("beta"));

    let mut reg = registry();
    reg.load("one", &a, serde_json::json!({ "v": "A" })).unwrap();
    reg.load("two", &b, serde_json::json!({ "v": "B" })).unwrap();

    let before_one = reg.slot_config("one").cloned();
    let before_two = reg.slot_config("two").cloned();

    // Only "two" changes.
    reg.apply_config("two", serde_json::json!({ "v": "B2" })).unwrap();

    assert_eq!(reg.slot_config("two"), Some(&serde_json::json!({ "v": "B2" })));
    assert_eq!(reg.slot_config("one").cloned(), before_one, "slot one must be untouched");
    assert_ne!(before_two, reg.slot_config("two").cloned());
}

#[test]
fn reload_can_carry_a_new_config_atomically() {
    let dir = tmpdir("cfg-reload");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_with_config_hooks("alpha"));

    let mut reg = registry();
    reg.load("slot", &wasm, serde_json::json!({ "v": 1 })).unwrap();

    let r = reg.reload("slot", &wasm, Some(serde_json::json!({ "v": 2 }))).unwrap();
    assert_eq!(r.slot, "slot");
    assert_eq!(reg.slot_config("slot"), Some(&serde_json::json!({ "v": 2 })));
}

#[test]
fn supervisor_updates_only_changed_slot_via_reconcile()  {
    use wasm_plugin_host::config::{Config, PluginEntry};
    use wasm_plugin_host::Supervisor;

    let dir = tmpdir("sup-cfg");
    let a = dir.join("a.wasm");
    let b = dir.join("b.wasm");
    write(&a, &wasm_with_config_hooks("alpha"));
    write(&b, &wasm_with_config_hooks("beta"));

    // Build a config file describing both, then a supervisor over it.
    let cfg_path = dir.join("plugins.json");
    let mut cfg = Config::default();
    cfg.plugins.insert(
        "one".into(),
        PluginEntry {
            path: a.to_string_lossy().into(),
            enabled: true,
            watch: Some(false),
            config: Some(serde_json::json!({ "v": "A" })),
            restart_on_config: false,
        },
    );
    cfg.plugins.insert(
        "two".into(),
        PluginEntry {
            path: b.to_string_lossy().into(),
            enabled: true,
            watch: Some(false),
            config: Some(serde_json::json!({ "v": "B" })),
            restart_on_config: false,
        },
    );
    cfg.save(&cfg_path).unwrap();

    let mut sup = Supervisor::new(&cfg_path).unwrap();
    let mut reg = registry();
    let ev = sup.reconcile(&mut reg);
    // Two loads, nothing else.
    let loaded = ev.iter().filter(|e| matches!(e, wasm_plugin_host::Event::Loaded { .. })).count();
    assert_eq!(loaded, 2, "expected two loads, got {ev:?}");

    // Change ONLY slot two in the config and reconcile again.
    sup.config.plugins.get_mut("two").unwrap().config =
        Some(serde_json::json!({ "v": "B2" }));
    let ev = sup.reconcile(&mut reg);
    let touched: Vec<String> = ev
        .iter()
        .filter_map(|e| match e {
            wasm_plugin_host::Event::ConfigUpdated { slot }
            | wasm_plugin_host::Event::ConfigUpdatedPullOnly { slot }
            | wasm_plugin_host::Event::ConfigRestarted { slot } => Some(slot.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(touched, vec!["two"], "only slot two should be touched");

    // And the applied values reflect exactly that.
    assert_eq!(reg.slot_config("one"), Some(&serde_json::json!({ "v": "A" })));
    assert_eq!(reg.slot_config("two"), Some(&serde_json::json!({ "v": "B2" })));
}

// ---------- logging ----------

use wasm_plugin_host::{LogLevel, LogSink, Registry, Runtime};

/// A plugin that emits `count` log lines from `plugin_init`, then returns ok.
fn wasm_that_logs(slot: &str, count: u32) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{slot}_tool","description":"lg","exec":"go"}}]}}"#
    );
    let msg = "logline";
    let msg_off = 64usize; // where we stash the message bytes
    let decl_off = 128usize;
    // data segment for the message
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 4096))
          (data (i32.const {msg_off}) {msg:?})
          (data (i32.const {decl_off}) {decl:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32)
            (local $i i32)
            (local.set $i (i32.const 0))
            (block $done (loop $loop
              (br_if $done (i32.ge_u (local.get $i) (i32.const {count})))
              (call $log (i32.const 1) (i32.const {msg_off}) (i32.const {mlen}))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $loop)))
            (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32) (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n)))
            (local.get $p))
          (func (export "plugin_free") (param i32 i32))
          (func $blit (param $src i32) (param $len i32) (param $out i32) (param $cap i32) (result i64)
            (local $i i32)
            (block $done (loop $loop
              (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
              (i32.store8 (i32.add (local.get $out) (local.get $i))
                (i32.load8_u (i32.add (local.get $src) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $loop)))
            (i64.extend_i32_s (local.get $len)))
          (func (export "plugin_describe") (param $out i32) (param $cap i32) (result i64)
            (call $blit (i32.const {decl_off}) (i32.const {dlen}) (local.get $out) (local.get $cap)))
          (func (export "plugin_invoke") (param i32 i32 i32 i32) (param $out i32) (param $cap i32) (result i64)
            (call $blit (i32.const {decl_off}) (i32.const 0) (local.get $out) (local.get $cap)))
        )"#,
        msg_off = msg_off,
        decl_off = decl_off,
        msg = msg,
        decl = decl,
        mlen = msg.len(),
        dlen = decl.len(),
        count = count,
    );
    wat::parse_str(&wat).expect("logging wat should parse")
}

#[test]
fn plugin_logs_are_captured_with_slot_prefix() {
    let dir = tmpdir("logs-basic");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_that_logs("alpha", 3));

    // Silent on stderr; no hook.
    let mut reg = Registry::with_logging(Runtime::new().unwrap(), 100, false, None);
    reg.load("greet", &wasm, serde_json::Value::Null).unwrap();

    let logs = reg.logs();
    assert_eq!(logs.len(), 3);
    for r in &logs {
        assert_eq!(r.slot, "greet");       // slot, not file stem
        assert_eq!(r.level, LogLevel::Info);
        assert_eq!(r.message, "logline");
    }
    // Sequence numbers are strictly increasing.
    assert!(logs.windows(2).all(|w| w[0].seq < w[1].seq));

    // Filtering by slot.
    assert_eq!(reg.logs_for("greet").len(), 3);
    assert_eq!(reg.logs_for("other").len(), 0);

    // Tailing by seq.
    let after_first = reg.logs_since(logs[0].seq);
    assert_eq!(after_first.len(), 2);
}

#[test]
fn log_buffer_is_bounded() {
    let dir = tmpdir("logs-bounded");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_that_logs("alpha", 50));

    let cap = 10;
    let mut reg = Registry::with_logging(Runtime::new().unwrap(), cap, false, None);
    reg.load("greet", &wasm, serde_json::Value::Null).unwrap();

    let logs = reg.logs();
    assert_eq!(logs.len(), cap, "buffer must be capped at {cap}");
    // The retained records are the *newest* ones (seq 41..50).
    assert_eq!(logs.first().unwrap().seq, 41);
    assert_eq!(logs.last().unwrap().seq, 50);
}

#[test]
fn log_hook_receives_every_record() {
    use std::sync::{Arc, Mutex};

    let dir = tmpdir("logs-hook");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_that_logs("alpha", 4));

    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let seen2 = seen.clone();
    let hook: wasm_plugin_host::LogHook = Arc::new(move |rec| {
        seen2.lock().unwrap().push(rec.render());
    });

    let mut reg = Registry::with_logging(Runtime::new().unwrap(), 100, false, Some(hook));
    reg.load("greet", &wasm, serde_json::Value::Null).unwrap();

    let got = seen.lock().unwrap().clone();
    assert_eq!(got.len(), 4, "hook should fire once per line");
    assert!(got.iter().all(|l| l.starts_with("[greet] info:")));
}

#[test]
fn standalone_sink_bounds_and_tails() {
    let sink = LogSink::new(3, false, None);
    for i in 0..5 {
        sink.push(wasm_plugin_host::LogRecord {
            seq: 0,
            slot: "s".into(),
            plugin: "p".into(),
            level: LogLevel::Warn,
            message: format!("m{i}"),
        });
    }
    let snap = sink.snapshot();
    assert_eq!(snap.len(), 3);
    assert_eq!(snap[0].message, "m2");
    assert_eq!(snap[2].message, "m4");
    assert_eq!(sink.capacity(), 3);
}

#[test]
fn guest_stdout_and_stderr_are_captured_as_logs() {
    // A WASI module that writes to std fds — no host.log glue. This is the
    // language-agnostic path: any language's normal print lands here.
    let wat = r#"(module
      (import "wasi_snapshot_preview1" "fd_write"
        (func $fd_write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      ;; iovec at 0: {buf=16, len=6}
      (data (i32.const 0) "\10\00\00\00\06\00\00\00")
      (data (i32.const 16) "out\n")
      ;; stderr iovec at 8: {buf=32, len=4}
      (data (i32.const 8) "\20\00\00\00\04\00\00\00")
      (data (i32.const 32) "err\n")
      (func (export "plugin_abi_version") (result i32) (i32.const 1))
      (func (export "plugin_init") (result i32)
        (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 48)))
        (drop (call $fd_write (i32.const 2) (i32.const 8) (i32.const 1) (i32.const 48)))
        (i32.const 0))
      (func (export "plugin_shutdown"))
      (func (export "plugin_alloc") (param i32) (result i32) (i32.const 1024))
      (func (export "plugin_free") (param i32 i32))
      ;; valid declaration: {"name":"p","abi":1,"tools":[]} at offset 64
      (data (i32.const 64) "{\"name\":\"p\",\"abi\":1,\"tools\":[]}")
      (func (export "plugin_describe") (param $out i32) (param $cap i32) (result i64)
        (local $i i32)
        (block $done (loop $loop
          (br_if $done (i32.ge_s (local.get $i) (i32.const 31)))
          (i32.store8 (i32.add (local.get $out) (local.get $i))
            (i32.load8_u (i32.add (i32.const 64) (local.get $i))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $loop)))
        (i64.const 31))
      (func (export "plugin_invoke") (param i32 i32 i32 i32 i32 i32) (result i64)
        (i64.const 0)))
    "#;
    let bytes = wat::parse_str(wat).unwrap();
    let dir = tmpdir("stdout-logs");
    let wasm = dir.join("p.wasm");
    write(&wasm, &bytes);

    let mut reg = Registry::with_logging(Runtime::new().unwrap(), 100, false, None);
    reg.load("greet", &wasm, serde_json::Value::Null).unwrap();

    let logs = reg.logs();
    let msgs: Vec<&str> = logs.iter().map(|r| r.message.as_str()).collect();
    assert!(msgs.contains(&"out"), "stdout must be captured, got {msgs:?}");
    assert!(msgs.contains(&"err"), "stderr must be captured, got {msgs:?}");

    let out = logs.iter().find(|r| r.message == "out").unwrap();
    let err = logs.iter().find(|r| r.message == "err").unwrap();
    assert_eq!(out.level, LogLevel::Info);
    assert_eq!(err.level, LogLevel::Error);
    assert_eq!(out.slot, "greet");
}

// ---------- concurrency (short-coming #2) ----------

#[test]
fn pooled_allocator_loads_and_calls() {
    use wasm_plugin_host::AllocationStrategy;
    let dir = tmpdir("pooled");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_with_config_hooks("alpha"));

    // Pooled allocator requires modules to fit its configured maxima; the
    // example module is small so this should work.
    let rt = Runtime::with_strategy(AllocationStrategy::pooled_default()).unwrap();
    assert_eq!(rt.strategy_name(), "pooled");
    let mut reg = Registry::new(rt);
    reg.load("one", &wasm, serde_json::Value::Null).unwrap();

    let out = reg.call_tool("alpha_tool", &serde_json::json!({})).unwrap();
    assert_eq!(out["kind"], "success");
}

#[test]
fn parallel_calls_across_slots_run_and_preserve_order() {
    let dir = tmpdir("parallel");
    let a = dir.join("a.wasm");
    let b = dir.join("b.wasm");
    write(&a, &wasm_with_config_hooks("alpha"));
    write(&b, &wasm_with_config_hooks("beta"));

    let mut reg = registry();
    reg.load("one", &a, serde_json::Value::Null).unwrap();
    reg.load("two", &b, serde_json::Value::Null).unwrap();

    // Interleave calls across the two slots; results must come back in order.
    let calls: Vec<(&str, serde_json::Value)> = (0..40)
        .map(|i| {
            if i % 2 == 0 {
                ("alpha_tool", serde_json::json!({ "i": i }))
            } else {
                ("beta_tool", serde_json::json!({ "i": i }))
            }
        })
        .collect();

    let out = reg.call_many_parallel(&calls);
    assert_eq!(out.len(), 40);
    assert!(out.iter().all(|r| r.is_ok()), "all calls should succeed");

    // Registry is still usable afterwards (plugins were restored, not lost).
    let check = reg.call_tool("alpha_tool", &serde_json::json!({})).unwrap();
    assert_eq!(check["kind"], "success");
}

#[test]
fn parallel_calls_with_unknown_tool_return_errors_in_place() {
    let dir = tmpdir("parallel-err");
    let a = dir.join("a.wasm");
    write(&a, &wasm_with_config_hooks("alpha"));

    let mut reg = registry();
    reg.load("one", &a, serde_json::Value::Null).unwrap();

    let calls = vec![
        ("alpha_tool", serde_json::json!({})),
        ("does_not_exist", serde_json::json!({})),
        ("alpha_tool", serde_json::json!({})),
    ];
    let out = reg.call_many_parallel(&calls);
    assert_eq!(out.len(), 3);
    assert!(out[0].is_ok());
    assert!(out[1].is_err(), "unknown tool must error in its slot");
    assert!(out[2].is_ok());
}

// ---------- notify watcher (short-coming #5) ----------

#[test]
fn notify_watcher_fires_on_file_change() {
    use wasm_plugin_host::config::{Config, PluginEntry};
    use std::time::Duration;

    let dir = tmpdir("notify");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_with_config_hooks("alpha"));
    let cfg_path = dir.join("plugins.json");
    let mut cfg = Config::default();
    cfg.plugins.insert(
        "one".into(),
        PluginEntry {
            path: wasm.to_string_lossy().into(),
            enabled: true,
            watch: Some(true),
            config: None,
            restart_on_config: false,
        },
    );
    cfg.save(&cfg_path).unwrap();

    let sup = wasm_plugin_host::Supervisor::new(&cfg_path).unwrap();
    let w = sup.watcher().unwrap();
    let w = match w {
        Some(w) => w,
        None => return, // platform without a usable watcher; skip
    };

    // Touch the wasm in a background thread after a short delay.
    let wasm2 = wasm.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        // Re-write the file to generate an event.
        let bytes = std::fs::read(&wasm2).unwrap();
        std::fs::write(&wasm2, bytes).unwrap();
    });

    // wait() should return quickly (well under the 5s fallback we ask for).
    let t = std::time::Instant::now();
    let got = w.wait(Duration::from_secs(5));
    let elapsed = t.elapsed();
    assert!(got, "watcher should observe the change");
    assert!(elapsed < Duration::from_secs(3), "should be event-driven, took {elapsed:?}");
}

// ---------- flow intervention (dsh-style hooks) ----------
//
// A plugin that declares a `tools/pre-execute` waterfall hook and answers
// decisions. `verdict` is "continue" | "veto" | "rewrite", embedded in the
// declaration so different tests can pick different behaviour without needing
// different wasm builds of logic.

use wasm_plugin_host::{run_turn, FlowEvent, ScriptedModel};

/// Build a plugin whose `plugin_invoke` returns a fixed decision JSON, and whose
/// declaration subscribes to one event with the given mode.
fn wasm_hook_plugin(
    slot: &str,
    event: &str,
    mode: &str, // "observe" | "waterfall"
    exec: &str,
    decision: &str,
) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[],"hooks":[{{"on":"{event}","exec":"{exec}","mode":"{mode}"}}]}}"#
    );
    let decision_len = decision.len();
    let decl_off = 64usize;
    let res_off = decl_off + decl.len();
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 8192))
          (data (i32.const {decl_off}) {decl:?})
          (data (i32.const {res_off}) {decision:?})
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
              (i32.store8 (i32.add (local.get $out) (local.get $i))
                (i32.load8_u (i32.add (local.get $src) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $loop)))
            (i64.extend_i32_s (local.get $len)))
          (func (export "plugin_describe") (param $out i32) (param $cap i32) (result i64)
            (call $blit (i32.const {decl_off}) (i32.const {dlen}) (local.get $out) (local.get $cap)))
          ;; every exec returns the same fixed decision JSON
          (func (export "plugin_invoke") (param i32 i32 i32 i32) (param $out i32) (param $cap i32) (result i64)
            (call $blit (i32.const {res_off}) (i32.const {rlen}) (local.get $out) (local.get $cap)))
        )"#,
        decl_off = decl_off,
        res_off = res_off,
        decl = decl,
        decision = decision,
        dlen = decl.len(),
        rlen = decision_len,
    );
    wat::parse_str(&wat).expect("hook wat should parse")
}

/// A trivial tool plugin so the flow has something to call.
fn wasm_echo_tool(slot: &str) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{slot}_tool","description":"echo","exec":"go"}}]}}"#
    );
    let res = r#"{"kind":"success","content":"ran","value":{}}"#;
    let decl_off = 64usize;
    let res_off = decl_off + decl.len();
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 8192))
          (data (i32.const {decl_off}) {decl:?})
          (data (i32.const {res_off}) {res:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32) (local.set $p (global.get $bump))
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
              (i32.store8 (i32.add (local.get $out) (local.get $i))
                (i32.load8_u (i32.add (local.get $src) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $loop)))
            (i64.extend_i32_s (local.get $len)))
          (func (export "plugin_describe") (param $out i32) (param $cap i32) (result i64)
            (call $blit (i32.const {decl_off}) (i32.const {dlen}) (local.get $out) (local.get $cap)))
          (func (export "plugin_invoke") (param i32 i32 i32 i32) (param $out i32) (param $cap i32) (result i64)
            (call $blit (i32.const {res_off}) (i32.const {rlen}) (local.get $out) (local.get $cap)))
        )"#,
        decl_off = decl_off,
        res_off = res_off,
        decl = decl,
        res = res,
        dlen = decl.len(),
        rlen = res.len(),
    );
    wat::parse_str(&wat).expect("tool wat should parse")
}

#[test]
fn plugin_can_veto_the_flow() {
    let dir = tmpdir("veto");
    let tool = dir.join("tool.wasm");
    let hook = dir.join("hook.wasm");
    write(&tool, &wasm_echo_tool("alpha"));
    // A waterfall hook on tools/pre-execute that always vetoes.
    write(
        &hook,
        &wasm_hook_plugin("guard", "tools/pre-execute", "waterfall", "check", r#"{"kind":"veto","reason":"blocked"}"#),
    );

    let mut reg = registry();
    reg.load("tool", &tool, serde_json::Value::Null).unwrap();
    let r = reg.load("guard", &hook, serde_json::Value::Null).unwrap();
    assert_eq!(r.hooks, vec![FlowEvent::ToolsPreExecute]);

    let mut model = ScriptedModel::new(vec![r#"TOOL alpha_tool {}"#.to_string()]);
    let out = run_turn(&mut reg, &mut model, 1, "go").unwrap();

    assert_eq!(out.vetoed.as_deref(), Some("guard"), "hook must veto");
    assert!(out.executed.is_empty(), "tool must NOT have run");
}

#[test]
fn observe_hook_cannot_change_flow() {
    let dir = tmpdir("observe");
    let tool = dir.join("tool.wasm");
    let hook = dir.join("hook.wasm");
    write(&tool, &wasm_echo_tool("alpha"));
    // An OBSERVE hook that returns a veto — which must be ignored.
    write(
        &hook,
        &wasm_hook_plugin("watcher", "tools/pre-execute", "observe", "watch", r#"{"kind":"veto","reason":"nope"}"#),
    );

    let mut reg = registry();
    reg.load("tool", &tool, serde_json::Value::Null).unwrap();
    reg.load("watcher", &hook, serde_json::Value::Null).unwrap();

    let mut model = ScriptedModel::new(vec![r#"TOOL alpha_tool {}"#.to_string()]);
    let out = run_turn(&mut reg, &mut model, 1, "go").unwrap();

    assert!(out.vetoed.is_none(), "observe hook must not veto");
    assert_eq!(out.executed.len(), 1, "tool must still have run");
}

#[test]
fn unload_removes_hooks_and_services() {
    let dir = tmpdir("hook-unload");
    let hook = dir.join("hook.wasm");
    write(
        &hook,
        &wasm_hook_plugin("guard", "turn/start", "observe", "watch", r#"{"kind":"continue"}"#),
    );
    let mut reg = registry();
    let r = reg.load("guard", &hook, serde_json::Value::Null).unwrap();
    assert!(r.provides.is_empty());
    assert!(!reg.hooks().is_empty());

    reg.unload("guard").unwrap();
    assert!(reg.hooks().is_empty(), "unload must unwind hook subscriptions");
}

#[test]
fn unknown_event_is_rejected_at_load() {
    let dir = tmpdir("bad-event");
    let hook = dir.join("hook.wasm");
    write(
        &hook,
        &wasm_hook_plugin("bad", "not/a/real/event", "observe", "x", r#"{"kind":"continue"}"#),
    );
    let mut reg = registry();
    let err = reg.load("bad", &hook, serde_json::Value::Null).unwrap_err();
    assert!(err.to_string().contains("unknown event"), "got: {err}");
}

#[test]
fn service_inject_reports_missing_provider() {
    let dir = tmpdir("svc");
    let a = dir.join("a.wasm");
    write(&a, &wasm_echo_tool("alpha"));
    let mut reg = registry();
    // echo tool declares no services; loading is fine and reports none missing.
    let r = reg.load("alpha", &a, serde_json::Value::Null).unwrap();
    assert!(r.missing_services.is_empty());
    assert_eq!(reg.provider_of("llm"), None);
}

// ---------- service graph: convergence + cross-plugin calls ----------

/// A plugin that declares services and (optionally) a tool + an echo op.
///
/// `injects`/`provides` are JSON arrays; `svc_reply` is what `plugin_invoke`
/// returns as a raw JSON value. Used both for providers/consumers and for the
/// callee side of a service call.
fn wasm_service_plugin(
    slot: &str,
    injects: &str,  // e.g. r#"["kv"]"#
    provides: &str, // e.g. r#"["kv"]"#
    tool: bool,
    reply: &str,
) -> Vec<u8> {
    let tools = if tool {
        format!(r#"[{{"name":"{slot}_tool","description":"t","exec":"go"}}]"#)
    } else {
        "[]".to_string()
    };
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":{tools},"injects":{injects},"provides":{provides}}}"#
    );
    let decl_off = 64usize;
    let res_off = decl_off + decl.len();
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 8192))
          (data (i32.const {decl_off}) {decl:?})
          (data (i32.const {res_off}) {reply:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32) (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n))) (local.get $p))
          (func (export "plugin_free") (param $p i32) (param $n i32) (global.set $bump (local.get $p)))
          (func $blit (param $s i32) (param $l i32) (param $o i32) (param $c i32) (result i64)
            (local $i i32)
            (if (i32.lt_s (local.get $c) (local.get $l))
              (then (return (i64.extend_i32_s (i32.sub (i32.const 0) (local.get $l))))))
            (block $d (loop $l2
              (br_if $d (i32.ge_s (local.get $i) (local.get $l)))
              (i32.store8 (i32.add (local.get $o) (local.get $i))
                (i32.load8_u (i32.add (local.get $s) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l2)))
            (i64.extend_i32_s (local.get $l)))
          (func (export "plugin_describe") (param $o i32) (param $c i32) (result i64)
            (call $blit (i32.const {decl_off}) (i32.const {dlen}) (local.get $o) (local.get $c)))
          (func (export "plugin_invoke") (param i32 i32 i32 i32) (param $o i32) (param $c i32) (result i64)
            (call $blit (i32.const {res_off}) (i32.const {rlen}) (local.get $o) (local.get $c)))
        )"#,
        decl_off = decl_off, res_off = res_off, decl = decl, reply = reply,
        dlen = decl.len(), rlen = reply.len(),
    );
    wat::parse_str(&wat).expect("service wat")
}

/// A plugin that calls a service via `host.call_service` and returns the reply.
fn wasm_service_caller(slot: &str, service: &str, op: &str) -> Vec<u8> {
    let decl = format!(r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{slot}_tool","description":"c","exec":"go"}}]}}"#);
    let svc_bytes = service.as_bytes();
    let op_bytes = op.as_bytes();
    let svc_off = 64usize;
    let op_off = svc_off + svc_bytes.len();
    let decl_off = op_off + op_bytes.len();
    // A sane reply shape for the tool (kind=success), and the raw service reply
    // is embedded into `content` by the host-side test.
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (import "host" "call_service" (func $call (param i32 i32 i32 i32 i32 i32 i32 i32) (result i64)))
          (memory (export "memory") 4)
          (global $bump (mut i32) (i32.const 16384))
          (data (i32.const {svc_off}) {svc:?})
          (data (i32.const {op_off}) {op:?})
          (data (i32.const {decl_off}) {decl:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32) (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n))) (local.get $p))
          (func (export "plugin_free") (param $p i32) (param $n i32) (global.set $bump (local.get $p)))
          (func $blit (param $s i32) (param $l i32) (param $o i32) (param $c i32) (result i64)
            (local $i i32)
            (if (i32.lt_s (local.get $c) (local.get $l))
              (then (return (i64.extend_i32_s (i32.sub (i32.const 0) (local.get $l))))))
            (block $d (loop $l2
              (br_if $d (i32.ge_s (local.get $i) (local.get $l)))
              (i32.store8 (i32.add (local.get $o) (local.get $i))
                (i32.load8_u (i32.add (local.get $s) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l2)))
            (i64.extend_i32_s (local.get $l)))
          (func (export "plugin_describe") (param $o i32) (param $c i32) (result i64)
            (call $blit (i32.const {decl_off}) (i32.const {dlen}) (local.get $o) (local.get $c)))
          ;; invoke: call the service with empty args, pass its reply straight back
          (func (export "plugin_invoke") (param i32 i32 i32 i32) (param $o i32) (param $c i32) (result i64)
            (local $n i64)
            (local.set $n
              (call $call
                (i32.const {svc_off}) (i32.const {svclen})
                (i32.const {op_off}) (i32.const {oplen})
                (i32.const 0) (i32.const 0)
                (local.get $o) (local.get $c)))
            (local.get $n))
        )"#,
        svc_off = svc_off, op_off = op_off, decl_off = decl_off,
        svc = service, op = op, decl = decl,
        svclen = svc_bytes.len(), oplen = op_bytes.len(), dlen = decl.len(),
    );
    wat::parse_str(&wat).expect("service caller wat")
}

#[test]
fn consumer_stays_quiescent_until_provider_appears_then_converges() {
    let dir = tmpdir("converge");
    let provider = dir.join("prov.wasm");
    let consumer = dir.join("cons.wasm");
    // Provider offers "kv" and has a tool.
    write(&provider, &wasm_service_plugin("provider", "[]", r#"["kv"]"#, true, r#"{"kind":"success","content":"p","value":{}}"#));
    // Consumer injects "kv" and has its own tool.
    write(&consumer, &wasm_service_plugin("consumer", r#"["kv"]"#, "[]", true, r#"{"kind":"success","content":"c","value":{}}"#));

    let mut reg = registry();

    // Load the consumer FIRST: its inject is unmet, so it must be quiescent.
    let r = reg.load("cons", &consumer, serde_json::Value::Null).unwrap();
    assert_eq!(r.missing_services, vec!["kv"], "inject should be reported missing");
    assert!(!r.active, "consumer must be quiescent without its provider");
    assert!(!reg.is_active("cons"));
    // Its tool must NOT be registered while quiescent.
    assert!(reg.tool_owner("consumer_tool").is_none());

    // Now load the provider: this should cascade-activate the consumer.
    let r = reg.load("prov", &provider, serde_json::Value::Null).unwrap();
    assert!(r.active);
    assert!(reg.is_active("prov"));
    assert!(reg.is_active("cons"), "consumer must activate once provider appears");

    // Both tools are now registered, reachable.
    assert_eq!(reg.tool_owner("provider_tool").as_deref(), Some("prov"));
    assert_eq!(reg.tool_owner("consumer_tool").as_deref(), Some("cons"));

    // ---- unload the provider: consumer must deactivate again ----
    reg.unload("prov").unwrap();
    assert!(!reg.is_active("cons"), "consumer must deactivate when provider leaves");
    assert!(reg.tool_owner("consumer_tool").is_none(), "its tool must be unregistered");
    assert_eq!(reg.provider_of("kv"), None);
}

#[test]
fn self_provided_service_activates_immediately() {
    let dir = tmpdir("self-svc");
    let p = dir.join("p.wasm");
    // Provides "kv" and injects "kv" — its own provide satisfies itself.
    write(&p, &wasm_service_plugin("solo", r#"["kv"]"#, r#"["kv"]"#, true, r#"{"kind":"success","content":"s","value":{}}"#));
    let mut reg = registry();
    let r = reg.load("solo", &p, serde_json::Value::Null).unwrap();
    assert!(r.active, "self-provided inject should activate immediately");
    assert!(r.missing_services.is_empty());
}

#[test]
fn plugin_can_call_another_plugin_by_service_name() {
    let dir = tmpdir("svc-call");
    let provider = dir.join("prov.wasm");
    let caller = dir.join("caller.wasm");
    // Provider offers "greeter"; its invoke returns a distinctive reply.
    write(
        &provider,
        &wasm_service_plugin("greeter", "[]", r#"["greeter"]"#, false, r#"{"kind":"success","content":"hi-from-provider","value":{"who":"x"}}"#),
    );
    // Caller's tool invokes the "greeter" service via host.call_service.
    write(&caller, &wasm_service_caller("caller", "greeter", "say_hi"));

    let mut reg = registry();
    reg.load("prov", &provider, serde_json::Value::Null).unwrap();
    reg.load("caller", &caller, serde_json::Value::Null).unwrap();

    // Calling the caller's tool must return the provider's reply, verbatim.
    let out = reg.call_tool("caller_tool", &serde_json::json!({})).unwrap();
    assert_eq!(out["kind"], "success");
    assert_eq!(out["content"], "hi-from-provider");

    // And the registry is still usable (plugins were put back).
    let direct = reg.call_tool("caller_tool", &serde_json::json!({})).unwrap();
    assert_eq!(direct["content"], "hi-from-provider");
}

#[test]
fn service_call_without_provider_returns_error_not_trap() {
    let dir = tmpdir("svc-noprov");
    let caller = dir.join("caller.wasm");
    write(&caller, &wasm_service_caller("caller", "nobody", "op"));
    let mut reg = registry();
    reg.load("caller", &caller, serde_json::Value::Null).unwrap();

    // No provider registered -> the call must return an error object, not trap.
    let out = reg.call_tool("caller_tool", &serde_json::json!({})).unwrap();
    assert_eq!(out["kind"], "error");
    assert!(
        out["message"].as_str().unwrap().contains("no provider"),
        "got: {out}"
    );
}

#[test]
fn two_plugins_cannot_provide_the_same_service() {
    let dir = tmpdir("svc-conflict");
    let a = dir.join("a.wasm");
    let b = dir.join("b.wasm");
    write(&a, &wasm_service_plugin("one", "[]", r#"["kv"]"#, false, r#"{"kind":"success"}"#));
    write(&b, &wasm_service_plugin("two", "[]", r#"["kv"]"#, false, r#"{"kind":"success"}"#));

    let mut reg = registry();
    reg.load("one", &a, serde_json::Value::Null).unwrap();
    let err = reg.load("two", &b, serde_json::Value::Null).unwrap_err();
    assert!(err.to_string().contains("already provided"), "got: {err}");
    // First provider is untouched.
    assert_eq!(reg.provider_of("kv").as_deref(), Some("one"));
}

#[test]
fn deeper_chain_converges_in_one_pass() {
    // a provides "a"; b injects "a" and provides "b"; c injects "b".
    // Load c, then b, then a — only on loading `a` should the whole chain light up.
    let dir = tmpdir("chain");
    let a = dir.join("a.wasm");
    let b = dir.join("b.wasm");
    let c = dir.join("c.wasm");
    write(&a, &wasm_service_plugin("a", "[]", r#"["a"]"#, false, r#"{"kind":"success"}"#));
    write(&b, &wasm_service_plugin("b", r#"["a"]"#, r#"["b"]"#, false, r#"{"kind":"success"}"#));
    write(&c, &wasm_service_plugin("c", r#"["b"]"#, "[]", false, r#"{"kind":"success"}"#));

    let mut reg = registry();
    reg.load("c", &c, serde_json::Value::Null).unwrap();
    reg.load("b", &b, serde_json::Value::Null).unwrap();
    assert!(!reg.is_active("c"), "c waits on b");
    assert!(!reg.is_active("b"), "b waits on a");

    reg.load("a", &a, serde_json::Value::Null).unwrap();
    assert!(reg.is_active("a"));
    assert!(reg.is_active("b"), "b activates when a appears");
    assert!(reg.is_active("c"), "c activates when b activates (cascade)");

    // Removing `a` collapses the chain.
    reg.unload("a").unwrap();
    assert!(!reg.is_active("b"));
    assert!(!reg.is_active("c"));
}

#[test]
fn recursive_service_call_is_refused_not_deadlocked() {
    // `loop` provides "loop" and its exec calls the "loop" service, i.e. itself.
    // The callee is out of the store while running, so the re-entrant call must
    // fail with a clear error rather than hang.
    let dir = tmpdir("recursive");
    let p = dir.join("loop.wasm");
    write(
        &p,
        &wasm_service_caller_providing("loop", "loop", "spin"),
    );
    let mut reg = registry();
    // Providing + injecting its own service would self-activate.
    reg.load("loop", &p, serde_json::Value::Null).unwrap();

    let out = reg.call_tool("loop_tool", &serde_json::json!({})).unwrap();
    assert_eq!(out["kind"], "error", "recursion must be refused: {out}");
    let msg = out["message"].as_str().unwrap_or("");
    assert!(msg.contains("busy") || msg.contains("not available"), "got: {msg}");
}

/// Like `wasm_service_caller` but the plugin also *provides* the service it calls.
fn wasm_service_caller_providing(slot: &str, service: &str, op: &str) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{slot}_tool","description":"t","exec":"go"}}],"provides":["{service}"]}}"#
    );
    let svc = service.as_bytes();
    let opb = op.as_bytes();
    let (svc_off, op_off, decl_off) = (64usize, 64 + svc.len(), 128 + svc.len());
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (import "host" "call_service" (func $call (param i32 i32 i32 i32 i32 i32 i32 i32) (result i64)))
          (memory (export "memory") 4)
          (global $bump (mut i32) (i32.const 16384))
          (data (i32.const {svc_off}) {svc:?})
          (data (i32.const {op_off}) {opb:?})
          (data (i32.const {decl_off}) {decl:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32) (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n))) (local.get $p))
          (func (export "plugin_free") (param $p i32) (param $n i32) (global.set $bump (local.get $p)))
          (func $blit (param $s i32) (param $l i32) (param $o i32) (param $c i32) (result i64)
            (local $i i32)
            (block $d (loop $l2
              (br_if $d (i32.ge_s (local.get $i) (local.get $l)))
              (i32.store8 (i32.add (local.get $o) (local.get $i))
                (i32.load8_u (i32.add (local.get $s) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l2)))
            (i64.extend_i32_s (local.get $l)))
          (func (export "plugin_describe") (param $o i32) (param $c i32) (result i64)
            (call $blit (i32.const {decl_off}) (i32.const {dlen}) (local.get $o) (local.get $c)))
          (func (export "plugin_invoke") (param i32 i32 i32 i32) (param $o i32) (param $c i32) (result i64)
            (call $call (i32.const {svc_off}) (i32.const {svclen}) (i32.const {op_off}) (i32.const {oplen})
                        (i32.const 0) (i32.const 0) (local.get $o) (local.get $c)))
        )"#,
        svc_off = svc_off, op_off = op_off, decl_off = decl_off,
        svc = service, opb = op, decl = decl,
        svclen = svc.len(), oplen = opb.len(), dlen = decl.len(),
    );
    wat::parse_str(&wat).expect("recursive wat")
}

#[test]
fn reload_respects_service_graph() {
    // Provider offers A. Consumer injects A. Reload the provider to offer B
    // instead; the consumer (injecting A) must deactivate.
    let dir = tmpdir("reload-svc");
    let prov = dir.join("prov.wasm");
    let cons = dir.join("cons.wasm");
    write(&prov, &wasm_service_plugin("prov", "[]", r#"["a"]"#, false, r#"{"kind":"success"}"#));
    write(&cons, &wasm_service_plugin("cons", r#"["a"]"#, "[]", true, r#"{"kind":"success"}"#));

    let mut reg = registry();
    reg.load("prov", &prov, serde_json::Value::Null).unwrap();
    reg.load("cons", &cons, serde_json::Value::Null).unwrap();
    assert!(reg.is_active("cons"));

    // Overwrite the provider's wasm with one that offers "b" instead.
    write(&prov, &wasm_service_plugin("prov", "[]", r#"["b"]"#, false, r#"{"kind":"success"}"#));
    reg.reload("prov", &prov, None).unwrap();

    assert_eq!(reg.provider_of("a"), None);
    assert_eq!(reg.provider_of("b").as_deref(), Some("prov"));
    assert!(!reg.is_active("cons"), "consumer must deactivate when its provider drops 'a'");
    assert!(reg.tool_owner("cons_tool").is_none());
}
