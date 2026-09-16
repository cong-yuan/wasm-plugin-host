//! P3: log-level filtering and config schema validation.

use std::path::{Path, PathBuf};

use wasm_plugin_host::{Config, LogLevel, LogSink, Registry, Runtime};

const RESULT_JSON: &str = r#"{"kind":"success","content":"ok","value":{}}"#;

/// A WAT plugin whose `plugin_init` emits one log line per level, so the sink
/// exercises the level filter end to end (through WASI stdout, not `host.log`).
fn wasm_logging_all_levels(slot: &str) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{slot}_tool","description":"t","exec":"go"}}]}}"#
    );
    // Lines carried in data segments; `plugin_init` calls host.log for each.
    let lines = [
        (0, "dbg"),
        (1, "nfo"),
        (2, "wrn"),
        (3, "err"),
    ];
    let decl_off = 256usize;
    let mut data = String::new();
    let mut off = decl_off + decl.len();
    let mut offsets = Vec::new();
    for (lvl, text) in lines {
        offsets.push((lvl, off, text.len()));
        data.push_str(&format!("(data (i32.const {off}) {text:?})\n"));
        off += text.len();
    }
    let res_off = off;
    let mut calls = String::new();
    for (lvl, ptr, len) in &offsets {
        calls.push_str(&format!(
            "(call $log (i32.const {lvl}) (i32.const {ptr}) (i32.const {len}))\n"
        ));
    }
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 8192))
          (data (i32.const {decl_off}) {decl:?})
          (data (i32.const {res_off}) {res:?})
          {data}
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32)
            {calls}
            (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n)))
            (local.get $p))
          (func (export "plugin_free") (param i32 i32))
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
        res = RESULT_JSON,
        data = data,
        calls = calls,
        decl = decl,
        dlen = decl.len(),
        rlen = RESULT_JSON.len(),
    );
    wat::parse_str(&wat).expect("test wat should parse")
}

fn tmpdir(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("wph-p3-{}-{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn write(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
}

// ---------------------------------------------------------------------------
// Log-level filtering (P3.3)
// ---------------------------------------------------------------------------

#[test]
fn sink_drops_records_below_the_min_level() {
    let sink = LogSink::new(100, false, None);
    assert_eq!(sink.min_level(), LogLevel::Debug, "default keeps everything");

    sink.push(rec(LogLevel::Debug, "d"));
    sink.push(rec(LogLevel::Info, "i"));
    assert_eq!(sink.len(), 2);

    sink.set_min_level(LogLevel::Warn);
    sink.push(rec(LogLevel::Debug, "d2"));
    sink.push(rec(LogLevel::Info, "i2"));
    sink.push(rec(LogLevel::Warn, "w"));
    sink.push(rec(LogLevel::Error, "e"));
    let msgs: Vec<String> = sink.snapshot().into_iter().map(|r| r.message).collect();
    assert_eq!(
        msgs,
        vec!["d", "i", "w", "e"],
        "records pushed before the level changed are kept; new sub-threshold ones are dropped"
    );
}

#[test]
fn prune_below_removes_already_buffered_records() {
    let sink = LogSink::new(100, false, None);
    for (l, m) in [
        (LogLevel::Debug, "d"),
        (LogLevel::Info, "i"),
        (LogLevel::Warn, "w"),
        (LogLevel::Error, "e"),
    ] {
        sink.push(rec(l, m));
    }
    let removed = sink.prune_below(LogLevel::Warn);
    assert_eq!(removed, 2);
    let msgs: Vec<String> = sink.snapshot().into_iter().map(|r| r.message).collect();
    assert_eq!(msgs, vec!["w", "e"]);
}

#[test]
fn guest_log_lines_are_filtered_through_the_wasm_boundary() {
    // The full path: plugin_init emits one line per level via WASI stdout;
    // a real Registry with min level = warn must retain only warn + error.
    let dir = tmpdir("filter");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_logging_all_levels("alpha"));

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.set_log_level(LogLevel::Warn);
    reg.load("slot", &wasm, serde_json::Value::Null).unwrap();

    let levels: Vec<LogLevel> = reg.logs().into_iter().map(|r| r.level).collect();
    assert!(
        levels.iter().all(|l| *l >= LogLevel::Warn),
        "only warn/error should survive, got {levels:?}"
    );
    assert_eq!(levels.len(), 2, "exactly the warn + error lines, got {levels:?}");
}

#[test]
fn registry_log_level_round_trips() {
    let reg = Registry::new(Runtime::new().unwrap());
    assert_eq!(reg.log_level(), LogLevel::Debug);
    reg.set_log_level(LogLevel::Error);
    assert_eq!(reg.log_level(), LogLevel::Error);
}

#[test]
fn level_names_parse_leniently() {
    assert_eq!(LogLevel::parse("warn"), Some(LogLevel::Warn));
    assert_eq!(LogLevel::parse("WARNING"), Some(LogLevel::Warn));
    assert_eq!(LogLevel::parse(" Error "), Some(LogLevel::Error));
    assert_eq!(LogLevel::parse("trace"), Some(LogLevel::Debug));
    assert_eq!(LogLevel::parse("nope"), None);
}

// ---------------------------------------------------------------------------
// Config validation (P3.4)
// ---------------------------------------------------------------------------

fn valid_config(dir: &Path) -> Config {
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_logging_all_levels("alpha"));
    let mut cfg = Config::default();
    cfg.plugins.insert(
        "alpha".to_string(),
        wasm_plugin_host::PluginEntry {
            path: "p.wasm".to_string(),
            enabled: true,
            watch: None,
            config: None,
            restart_on_config: false,
        },
    );
    cfg
}

#[test]
fn a_valid_config_reports_no_issues() {
    let dir = tmpdir("valid");
    let cfg = valid_config(&dir);
    assert!(cfg.validate(&dir).is_empty(), "{:?}", cfg.validate(&dir));
}

#[test]
fn a_missing_enabled_plugin_file_is_reported_with_its_field() {
    let dir = tmpdir("missing");
    let cfg = valid_config(&dir);
    std::fs::remove_file(dir.join("p.wasm")).unwrap();
    let issues = cfg.validate(&dir);
    assert_eq!(issues.len(), 1, "got {issues:?}");
    assert_eq!(issues[0].field, "plugins.alpha.path");
    assert!(issues[0].message.contains("not found"), "{}", issues[0].message);
}

#[test]
fn a_disabled_plugin_may_point_at_a_file_that_does_not_exist_yet() {
    let dir = tmpdir("disabled");
    let mut cfg = valid_config(&dir);
    std::fs::remove_file(dir.join("p.wasm")).unwrap();
    cfg.plugins.get_mut("alpha").unwrap().enabled = false;
    assert!(
        cfg.validate(&dir).is_empty(),
        "a disabled entry is allowed to reference a not-yet-built artifact"
    );
}

#[test]
fn a_non_wasm_extension_is_reported() {
    let dir = tmpdir("notwasm");
    write(&dir.join("p.txt"), b"hello");
    let mut cfg = Config::default();
    cfg.plugins.insert(
        "alpha".to_string(),
        wasm_plugin_host::PluginEntry {
            path: "p.txt".to_string(),
            enabled: true,
            watch: None,
            config: None,
            restart_on_config: false,
        },
    );
    let issues = cfg.validate(&dir);
    assert_eq!(issues.len(), 1);
    assert!(issues[0].message.contains(".wasm"), "{}", issues[0].message);
}

#[test]
fn an_unknown_log_level_is_reported() {
    let dir = tmpdir("badlevel");
    let mut cfg = valid_config(&dir);
    cfg.log_level = Some("loud".to_string());
    let issues = cfg.validate(&dir);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].field, "log_level");
}

#[test]
fn a_zero_watch_interval_is_reported() {
    let dir = tmpdir("zerointerval");
    let mut cfg = valid_config(&dir);
    cfg.watch.interval_ms = 0;
    let issues = cfg.validate(&dir);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].field, "watch.interval_ms");
}

#[test]
fn all_problems_are_reported_at_once_not_just_the_first() {
    let dir = tmpdir("many");
    let mut cfg = valid_config(&dir);
    std::fs::remove_file(dir.join("p.wasm")).unwrap();
    cfg.log_level = Some("nope".to_string());
    cfg.watch.interval_ms = 0;
    let issues = cfg.validate(&dir);
    assert_eq!(issues.len(), 3, "expected 3 issues, got {issues:?}");
}

#[test]
fn load_validated_rejects_a_bad_config_with_a_readable_error() {
    let dir = tmpdir("loadvalid");
    let cfg = valid_config(&dir);
    let path = dir.join("plugins.json");
    cfg.save(&path).unwrap();
    std::fs::remove_file(dir.join("p.wasm")).unwrap();

    let err = Config::load_validated(&path).unwrap_err();
    let text = err.to_string();
    assert!(text.contains("plugins.alpha.path"), "got: {text}");
    assert!(text.contains("problem"), "got: {text}");
}

#[test]
fn load_validated_accepts_a_good_config() {
    let dir = tmpdir("loadvalid-ok");
    let cfg = valid_config(&dir);
    let path = dir.join("plugins.json");
    cfg.save(&path).unwrap();
    let reloaded = Config::load_validated(&path).unwrap();
    assert_eq!(reloaded.plugins.len(), 1);
}

#[test]
fn cache_config_round_trips_through_json_and_validates() {
    let dir = tmpdir("cache-cfg");
    let text = r#"{
      "cache": { "dir": "../caches", "enabled": true },
      "log_level": "warn",
      "watch": { "enabled": false, "interval_ms": 400 },
      "plugins": {}
    }"#;
    let cfg: Config = serde_json::from_str(text).unwrap();
    assert_eq!(cfg.cache.as_ref().unwrap().dir, "../caches");
    assert_eq!(cfg.log_level.as_deref(), Some("warn"));
    assert!(cfg.validate(&dir).is_empty(), "{:?}", cfg.validate(&dir));
}

#[test]
fn an_empty_cache_dir_when_enabled_is_reported() {
    let dir = tmpdir("empty-cache");
    let text = r#"{ "cache": { "dir": "  ", "enabled": true }, "plugins": {} }"#;
    let cfg: Config = serde_json::from_str(text).unwrap();
    let issues = cfg.validate(&dir);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].field, "cache.dir");
}

fn rec(level: LogLevel, message: &str) -> wasm_plugin_host::LogRecord {
    wasm_plugin_host::LogRecord {
        seq: 0,
        slot: "s".to_string(),
        plugin: "p".to_string(),
        level,
        message: message.to_string(),
    }
}
