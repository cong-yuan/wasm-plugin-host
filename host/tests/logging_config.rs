//! P3: log-level filtering and config schema validation.

use std::path::{Path, PathBuf};

use wasm_plugin_host::{
    CapabilitySet, Config, FilesystemCapabilities, LogLevel, LogSink, NetworkCapabilities,
    PluginPolicy, Registry, Runtime, TrustMode,
};

const RESULT_JSON: &str = r#"{"kind":"success","content":"ok","value":{}}"#;

/// A WAT plugin whose `plugin_init` emits one log line per level, so the sink
/// exercises the level filter end to end (through WASI stdout, not `host.log`).
fn wasm_logging_all_levels(slot: &str) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{slot}_tool","description":"t","exec":"go"}}]}}"#
    );
    // Lines carried in data segments; `plugin_init` calls host.log for each.
    let lines = [(0, "dbg"), (1, "nfo"), (2, "wrn"), (3, "err")];
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
    assert_eq!(
        sink.min_level(),
        LogLevel::Debug,
        "default keeps everything"
    );

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
    assert_eq!(
        levels.len(),
        2,
        "exactly the warn + error lines, got {levels:?}"
    );
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
            ..Default::default()
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
    assert!(
        issues[0].message.contains("not found"),
        "{}",
        issues[0].message
    );
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
            ..Default::default()
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
fn capability_policy_round_trips_and_old_entries_default_to_trusted() {
    let old: wasm_plugin_host::PluginEntry =
        serde_json::from_str(r#"{ "path": "p.wasm", "enabled": false }"#).unwrap();
    assert_eq!(old.trust, TrustMode::Trusted);
    assert!(old.grant.is_empty());

    let entry: wasm_plugin_host::PluginEntry = serde_json::from_str(
        r#"{
          "path": "p.wasm",
          "enabled": false,
          "trust": "sandboxed",
          "grant": {
            "network": {
              "allow": ["api.example.com"],
              "methods": ["GET"]
            }
          },
          "limits": {
            "memory_mb": 32,
            "fuel": 1234,
            "call_timeout_ms": 2500,
            "max_concurrent_calls": 1,
            "max_output_bytes": 4096,
            "max_log_bytes_per_call": 2048
          }
        }"#,
    )
    .unwrap();
    assert_eq!(entry.trust, TrustMode::Sandboxed);
    assert_eq!(entry.grant.network.allow, vec!["api.example.com"]);
    assert_eq!(entry.limits.memory_mb, 32);

    let json = serde_json::to_string(&entry).unwrap();
    let back: wasm_plugin_host::PluginEntry = serde_json::from_str(&json).unwrap();
    assert_eq!(back.policy(), entry.policy());
}

#[test]
fn zero_sandbox_resource_limits_are_rejected_by_config_validation() {
    let dir = tmpdir("bad-limits");
    let mut cfg = valid_config(&dir);
    let entry = cfg.plugins.get_mut("alpha").unwrap();
    entry.trust = TrustMode::Sandboxed;
    entry.limits.memory_mb = 0;
    entry.limits.fuel = 0;
    entry.limits.call_timeout_ms = 0;
    entry.limits.max_concurrent_calls = 0;
    entry.limits.max_output_bytes = 0;
    entry.limits.max_log_bytes_per_call = 0;
    let fields: Vec<String> = cfg.validate(&dir).into_iter().map(|i| i.field).collect();
    assert!(fields.contains(&"plugins.alpha.limits.memory_mb".to_string()));
    assert!(fields.contains(&"plugins.alpha.limits.fuel".to_string()));
    assert!(fields.contains(&"plugins.alpha.limits.call_timeout_ms".to_string()));
    assert!(fields.contains(&"plugins.alpha.limits.max_concurrent_calls".to_string()));
    assert!(fields.contains(&"plugins.alpha.limits.max_output_bytes".to_string()));
    assert!(fields.contains(&"plugins.alpha.limits.max_log_bytes_per_call".to_string()));
}

#[test]
fn overlapping_sandbox_filesystem_grants_are_rejected() {
    let dir = tmpdir("overlap-grants");
    let child = dir.join("child");
    std::fs::create_dir_all(&child).unwrap();

    let policy = PluginPolicy {
        trust: TrustMode::Sandboxed,
        grant: CapabilitySet {
            filesystem: wasm_plugin_host::FilesystemCapabilities {
                read: vec![
                    dir.to_string_lossy().into_owned(),
                    child.to_string_lossy().into_owned(),
                ],
                ..Default::default()
            },
            ..Default::default()
        },
        ..Default::default()
    };

    let err = policy.validate_for_load().unwrap_err();
    assert!(err.contains("overlapping"), "got: {err}");
    assert!(err.contains("child"), "got: {err}");
}

#[test]
fn sandboxed_mutation_grants_accept_existing_absolute_roots() {
    let dir = tmpdir("mutation-grants");
    let root = dir.to_string_lossy().into_owned();
    let policy = PluginPolicy {
        trust: TrustMode::Sandboxed,
        grant: CapabilitySet {
            filesystem: wasm_plugin_host::FilesystemCapabilities {
                write: vec![root.clone()],
                create: vec![root.clone()],
                delete: vec![root],
                ..Default::default()
            },
            ..Default::default()
        },
        ..Default::default()
    };

    policy
        .validate_for_load()
        .expect("fine-grained mutation roots should be accepted");
}

#[test]
fn sandboxed_concurrency_limit_cannot_claim_unimplemented_parallelism() {
    let policy = PluginPolicy {
        trust: TrustMode::Sandboxed,
        limits: wasm_plugin_host::ResourceLimits {
            max_concurrent_calls: 2,
            ..Default::default()
        },
        ..Default::default()
    };
    let err = policy.validate_for_load().unwrap_err();
    assert!(err.contains("max_concurrent_calls"), "got: {err}");
    assert!(err.contains("must be 1"), "got: {err}");
}

#[test]
fn rejected_load_policy_is_recorded_in_the_host_audit_stream() {
    let dir = tmpdir("audit-load-policy");
    let path = dir.join("p.wasm");
    let mut reg = Registry::new(Runtime::new().unwrap());
    let err = reg
        .load_with_policy(
            "bad-policy",
            &path,
            serde_json::Value::Null,
            PluginPolicy {
                trust: TrustMode::Sandboxed,
                limits: wasm_plugin_host::ResourceLimits {
                    max_concurrent_calls: 2,
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(err.to_string().contains("max_concurrent_calls"));

    let events = reg.audit_events_for("bad-policy");
    assert!(events.iter().any(|event| {
        event.decision == wasm_plugin_host::AuditDecision::Deny
            && event.capability == "policy.load"
            && event.reason.as_deref().unwrap_or("").contains("max_concurrent_calls")
    }), "audit: {events:?}");
}

#[test]
fn config_reports_sandboxed_concurrency_error_on_the_limits_field() {
    let dir = tmpdir("bad-concurrency-limit");
    let mut cfg = valid_config(&dir);
    let entry = cfg.plugins.get_mut("alpha").unwrap();
    entry.trust = TrustMode::Sandboxed;
    entry.limits.max_concurrent_calls = 2;

    let issues = cfg.validate(&dir);
    assert!(
        issues.iter().any(|i| {
            i.field == "plugins.alpha.limits.max_concurrent_calls"
                && i.message.contains("must be 1")
        }),
        "issues: {issues:?}"
    );
    assert!(
        !issues.iter().any(|i| {
            i.field == "plugins.alpha.grant.filesystem"
                && i.message.contains("max_concurrent_calls")
        }),
        "concurrency validation must not be mislabeled as filesystem: {issues:?}"
    );
}

#[test]
fn sandbox_mutation_grants_round_trip_through_config_validation() {
    let dir = tmpdir("mutation-grants-config");
    let root = dir.to_string_lossy().into_owned();
    let mut cfg = valid_config(&dir);
    let entry = cfg.plugins.get_mut("alpha").unwrap();
    entry.trust = TrustMode::Sandboxed;
    entry.grant.filesystem.write.push(root.clone());
    entry.grant.filesystem.create.push(root.clone());
    entry.grant.filesystem.delete.push(root);
    let issues = cfg.validate(&dir);
    assert!(issues.is_empty(), "issues: {issues:?}");
}

#[test]
fn sandbox_filesystem_grants_must_be_absolute_existing_directories() {
    let dir = tmpdir("bad-fs-paths");
    let mut cfg = valid_config(&dir);
    {
        let entry = cfg.plugins.get_mut("alpha").unwrap();
        entry.trust = TrustMode::Sandboxed;
        entry.grant.filesystem.read.push("relative/path".into());
    }
    let issues = cfg.validate(&dir);
    assert!(
        issues.iter().any(|i| {
            i.field == "plugins.alpha.grant.filesystem" && i.message.contains("absolute path")
        }),
        "issues: {issues:?}"
    );

    let file = dir.join("not-a-directory");
    std::fs::write(&file, b"x").unwrap();
    {
        let entry = cfg.plugins.get_mut("alpha").unwrap();
        entry.grant.filesystem.read.clear();
        entry
            .grant
            .filesystem
            .read
            .push(file.to_string_lossy().into_owned());
    }
    let issues = cfg.validate(&dir);
    assert!(
        issues.iter().any(|i| {
            i.field == "plugins.alpha.grant.filesystem" && i.message.contains("not a directory")
        }),
        "issues: {issues:?}"
    );
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

#[test]
fn the_extra_section_round_trips_untouched() {
    // `extra` is the embedder's own space: the plugin runtime must not touch it,
    // and it must survive a save/load cycle verbatim (a GUI keeps its settings
    // there, alongside the plugin entries).
    let dir = tmpdir("extra");
    let text = r#"{
      "plugins": {},
      "extra": { "llm": { "providers": { "deepseek": { "base_url": "http://x" } } } }
    }"#;
    let cfg: Config = serde_json::from_str(text).unwrap();
    assert_eq!(
        cfg.extra.as_ref().unwrap()["llm"]["providers"]["deepseek"]["base_url"],
        "http://x"
    );
    // Valid, since extra is opaque to validation.
    assert!(cfg.validate(&dir).is_empty(), "{:?}", cfg.validate(&dir));

    // Round-trip through disk.
    let path = dir.join("c.json");
    cfg.save(&path).unwrap();
    let back = Config::load(&path).unwrap();
    assert_eq!(back.extra, cfg.extra, "extra must survive a round trip");
}

// ---------------------------------------------------------------------------
// The capability boundary — what a WASM plugin can actually reach
// ---------------------------------------------------------------------------

/// A plugin that calls `fd_prestat_get(3)` during init and reports the errno via
/// `host.log`. That errno is direct evidence about the WASI filesystem
/// capability the host granted.
///
/// WASI p1's model is *preopen whitelisting*: a guest can only reach a directory
/// the host explicitly preopened with `WasiCtxBuilder::preopened_dir`. This host
/// preopens nothing, so there is no preopen to find.
fn wasm_prestat_probe() -> Vec<u8> {
    // Layout: decl at 16, errno string at 128, report label at 200.
    let decl = r#"{"name":"probe","abi":1,"tools":[]}"#;
    let decl_off = 16usize;
    let label = "prestat-fd3=";
    let label_off = 256usize;
    let errno_off = label_off + label.len();
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (import "wasi_snapshot_preview1" "fd_prestat_get"
            (func $prestat (param i32 i32) (result i32)))
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 4096))
          (data (i32.const {decl_off}) {decl:?})
          (data (i32.const {label_off}) {label:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32)
            (local $rc i32)
            ;; Ask whether fd 3 is a preopened directory.
            (local.set $rc (call $prestat (i32.const 3) (i32.const 1024)))
            ;; Report: "prestat-fd3=<errno>" — encode the errno as a single char.
            (i32.store8 (i32.const {errno_off}) (i32.add (i32.const 48) (local.get $rc)))
            (call $log (i32.const 1)
              (i32.const {label_off})
              (i32.const {report_len}))
            (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n)))
            (local.get $p))
          (func (export "plugin_free") (param i32 i32))
          (func (export "plugin_describe") (param $out i32) (param $cap i32) (result i64)
            (local $i i32)
            (local $n i32)
            (local.set $n (i32.const {dlen}))
            (if (i32.lt_s (local.get $cap) (local.get $n))
              (then (return (i64.extend_i32_s (i32.sub (i32.const 0) (local.get $n))))))
            (block $d (loop $l
              (br_if $d (i32.ge_s (local.get $i) (local.get $n)))
              (i32.store8 (i32.add (local.get $out) (local.get $i))
                (i32.load8_u (i32.add (i32.const {decl_off}) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $l)))
            (i64.extend_i32_s (local.get $n)))
          (func (export "plugin_invoke")
            (param i32 i32 i32 i32) (param i32 i32) (result i64) (i64.const 0))
        )"#,
        decl_off = decl_off,
        decl = decl,
        dlen = decl.len(),
        label_off = label_off,
        label = label,
        errno_off = errno_off,
        report_len = label.len() + 1,
    );
    wat::parse_str(&wat).expect("prestat probe should parse")
}

fn wasm_path_open_probe(file_name: &str) -> Vec<u8> {
    let decl = r#"{"name":"path-probe","abi":1,"tools":[]}"#;
    let decl_off = 16usize;
    let path_off = 256usize;
    let label = "path-open=";
    let label_off = 512usize;
    let errno_off = label_off + label.len();
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (import "wasi_snapshot_preview1" "path_open"
            (func $path_open
              (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
          (import "wasi_snapshot_preview1" "fd_close"
            (func $fd_close (param i32) (result i32)))
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 4096))
          (data (i32.const {decl_off}) {decl:?})
          (data (i32.const {path_off}) {file_name:?})
          (data (i32.const {label_off}) {label:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32)
            (local $rc i32)
            (local $opened i32)
            (local.set $rc
              (call $path_open
                (i32.const 3)
                (i32.const 0)
                (i32.const {path_off}) (i32.const {path_len})
                (i32.const 0)
                (i64.const 2)
                (i64.const 0)
                (i32.const 0)
                (i32.const 1024)))
            (if (i32.eqz (local.get $rc))
              (then
                (local.set $opened (i32.load (i32.const 1024)))
                (drop (call $fd_close (local.get $opened)))))
            (i32.store8
              (i32.const {errno_off})
              (i32.add (i32.const 48) (local.get $rc)))
            (call $log
              (i32.const 1)
              (i32.const {label_off})
              (i32.const {report_len}))
            (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n)))
            (local.get $p))
          (func (export "plugin_free") (param i32 i32))
          (func (export "plugin_describe") (param $out i32) (param $cap i32) (result i64)
            (local $i i32)
            (if (i32.lt_s (local.get $cap) (i32.const {dlen}))
              (then
                (return
                  (i64.extend_i32_s
                    (i32.sub (i32.const 0) (i32.const {dlen}))))))
            (block $done
              (loop $copy
                (br_if $done (i32.ge_s (local.get $i) (i32.const {dlen})))
                (i32.store8
                  (i32.add (local.get $out) (local.get $i))
                  (i32.load8_u
                    (i32.add (i32.const {decl_off}) (local.get $i))))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $copy)))
            (i64.const {dlen}))
          (func (export "plugin_invoke")
            (param i32 i32 i32 i32) (param i32 i32) (result i64)
            (i64.const 0))
        )"#,
        decl_off = decl_off,
        decl = decl,
        dlen = decl.len(),
        path_off = path_off,
        file_name = file_name,
        path_len = file_name.len(),
        label_off = label_off,
        label = label,
        errno_off = errno_off,
        report_len = label.len() + 1,
    );
    wat::parse_str(&wat).expect("path_open probe should parse")
}

#[test]
fn a_trusted_plugin_gets_a_filesystem_preopen() {
    // Trusted compatibility mode preserves the historical root preopen, so
    // ordinary first-party Rust/Go guests keep their existing filesystem behavior.
    let dir = tmpdir("no-preopen");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_prestat_probe());

    let mut reg = Registry::new(Runtime::new().unwrap());
    // The plugin must load (it only calls WASI from `plugin_init`), proving the
    // symbol is linked, i.e. "can call" and "is allowed" are different things.
    reg.load("probe", &wasm, serde_json::Value::Null)
        .expect("a plugin may LINK wasi filesystem calls");

    let msg = reg
        .logs()
        .into_iter()
        .find(|r| r.message.starts_with("prestat-fd3="))
        .map(|r| r.message)
        .expect("the probe should have reported an errno");

    // fd_prestat_get returns 0 only for a real preopen. Anything else (EBADF=8,
    // ENOTCAPABLE=76, ...) means fd 3 is NOT a preopened directory.
    let errno: u32 = msg
        .trim_start_matches("prestat-fd3=")
        .parse()
        .expect("errno digit");
    // DECISION CHANGE: plugins are trusted, so the host now preopens `/` and
    // fd 3 **is** a real preopen directory (fd_prestat_get returns 0).
    assert_eq!(
        errno, 0,
        "fd 3 should be a preopen: trusted plugins get full filesystem access"
    );
}

#[test]
fn a_sandboxed_plugin_gets_no_filesystem_preopen_by_default() {
    let dir = tmpdir("sandbox-no-preopen");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_prestat_probe());

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "probe",
        &wasm,
        serde_json::Value::Null,
        PluginPolicy {
            trust: TrustMode::Sandboxed,
            ..Default::default()
        },
    )
    .expect("sandboxed plugin should still instantiate without filesystem access");

    let msg = reg
        .logs()
        .into_iter()
        .find(|r| r.message.starts_with("prestat-fd3="))
        .map(|r| r.message)
        .expect("the probe should have reported an errno");
    assert_ne!(
        msg, "prestat-fd3=0",
        "sandboxed plugins must not inherit the host root preopen"
    );
}

#[test]
fn a_sandboxed_read_grant_creates_only_an_explicit_preopen() {
    let dir = tmpdir("sandbox-read-preopen");
    let allowed = dir.join("allowed");
    std::fs::create_dir_all(&allowed).unwrap();
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_prestat_probe());

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "probe",
        &wasm,
        serde_json::Value::Null,
        PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                filesystem: FilesystemCapabilities {
                    read: vec![allowed.to_string_lossy().into_owned()],
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .expect("explicit read grant should become a WASI preopen");

    let msg = reg
        .logs()
        .into_iter()
        .find(|r| r.message.starts_with("prestat-fd3="))
        .map(|r| r.message)
        .expect("the probe should have reported fd 3");
    assert_eq!(msg, "prestat-fd3=0");
}

#[test]
fn sandboxed_path_open_succeeds_inside_an_explicit_read_grant() {
    let dir = tmpdir("sandbox-path-open-allow");
    let allowed = dir.join("allowed");
    std::fs::create_dir_all(&allowed).unwrap();
    std::fs::write(allowed.join("secret.txt"), b"hello").unwrap();
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_path_open_probe("secret.txt"));

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "probe",
        &wasm,
        serde_json::Value::Null,
        PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                filesystem: FilesystemCapabilities {
                    read: vec![allowed.to_string_lossy().into_owned()],
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .expect("read-granted file should be openable through its preopen");

    let msg = reg
        .logs()
        .into_iter()
        .find(|r| r.message.starts_with("path-open="))
        .map(|r| r.message)
        .expect("path_open probe should log its errno");
    assert_eq!(msg, "path-open=0");
}

#[test]
fn sandboxed_path_open_fails_without_a_filesystem_grant() {
    let dir = tmpdir("sandbox-path-open-deny");
    std::fs::write(dir.join("secret.txt"), b"hello").unwrap();
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_path_open_probe("secret.txt"));

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "probe",
        &wasm,
        serde_json::Value::Null,
        PluginPolicy {
            trust: TrustMode::Sandboxed,
            ..Default::default()
        },
    )
    .expect("missing filesystem grant should deny the operation, not plugin load");

    let msg = reg
        .logs()
        .into_iter()
        .find(|r| r.message.starts_with("path-open="))
        .map(|r| r.message)
        .expect("path_open probe should log its errno");
    assert_ne!(msg, "path-open=0");
}

#[cfg(unix)]
#[test]
fn trusted_root_preopen_can_open_real_etc_passwd() {
    if !std::path::Path::new("/etc/passwd").exists() {
        return;
    }
    let dir = tmpdir("trusted-etc-passwd");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_path_open_probe("etc/passwd"));

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load("probe", &wasm, serde_json::Value::Null)
        .expect("trusted compatibility mode should expose the root preopen");

    let msg = reg
        .logs()
        .into_iter()
        .find(|r| r.message.starts_with("path-open="))
        .map(|r| r.message)
        .expect("path_open probe should log its errno");
    assert_eq!(msg, "path-open=0");
}

#[cfg(unix)]
#[test]
fn sandboxed_unrelated_preopen_cannot_escape_to_real_etc_passwd() {
    if !std::path::Path::new("/etc/passwd").exists() {
        return;
    }
    let dir = tmpdir("sandbox-etc-passwd");
    let allowed = dir.join("allowed");
    std::fs::create_dir_all(&allowed).unwrap();
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_path_open_probe("/etc/passwd"));

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "probe",
        &wasm,
        serde_json::Value::Null,
        PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                filesystem: FilesystemCapabilities {
                    read: vec![allowed.to_string_lossy().into_owned()],
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .expect("sandbox plugin should load with only the unrelated preopen");

    let msg = reg
        .logs()
        .into_iter()
        .find(|r| r.message.starts_with("path-open="))
        .map(|r| r.message)
        .expect("path_open probe should log its errno");
    assert_ne!(
        msg, "path-open=0",
        "an unrelated sandbox preopen must not permit opening /etc/passwd"
    );
}

#[test]
fn a_plugin_cannot_import_a_host_call_the_host_does_not_offer() {
    // The guest's capability surface is exactly the host imports the linker
    // registers. Anything else fails at instantiation — there is no ambient
    // "full permission" to fall back on.
    let wat = r#"(module
          (import "host" "read_any_file" (func $x (param i32) (result i32)))
          (memory (export "memory") 1)
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param i32) (result i32) (i32.const 8192))
          (func (export "plugin_free") (param i32 i32))
          (func (export "plugin_describe") (param i32 i32) (result i64) (i64.const 0))
          (func (export "plugin_invoke")
            (param i32 i32 i32 i32) (param i32 i32) (result i64) (i64.const 0))
        )"#;
    let dir = tmpdir("no-import");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wat::parse_str(wat).unwrap());

    let mut reg = Registry::new(Runtime::new().unwrap());
    let err = reg
        .load("probe", &wasm, serde_json::Value::Null)
        .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("unknown import") && msg.contains("read_any_file"),
        "an unregistered host import must fail instantiation, got: {msg}"
    );
}

#[test]
fn a_plugin_cannot_open_a_socket() {
    // No network capability: WASI's socket calls are not even in the linker, so
    // a module importing one cannot instantiate.
    let wat = r#"(module
          (import "wasi_snapshot_preview1" "sock_open"
            (func $s (param i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param i32) (result i32) (i32.const 8192))
          (func (export "plugin_free") (param i32 i32))
          (func (export "plugin_describe") (param i32 i32) (result i64) (i64.const 0))
          (func (export "plugin_invoke")
            (param i32 i32 i32 i32) (param i32 i32) (result i64) (i64.const 0))
        )"#;
    let dir = tmpdir("no-socket");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wat::parse_str(wat).unwrap());

    let mut reg = Registry::new(Runtime::new().unwrap());
    let err = reg
        .load("probe", &wasm, serde_json::Value::Null)
        .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("unknown import") && msg.contains("sock_open"),
        "socket calls must be absent from the linker, got: {msg}"
    );
}

/// A WAT plugin that fetches `url` during init and logs the JSON reply.
fn wasm_http_probe(url: &str) -> Vec<u8> {
    let req = serde_json::json!({ "url": url }).to_string();
    let decl = r#"{"name":"fetcher","abi":1,"tools":[]}"#;
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (import "host" "http_fetch"
            (func $fetch (param i32 i32 i32 i32) (result i64)))
          (memory (export "memory") 4)
          (global $bump (mut i32) (i32.const 16384))
          (data (i32.const 100) {req:?})
          (data (i32.const 600) {decl:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32)
            (local $n i64)
            (local.set $n
              (call $fetch (i32.const 100) (i32.const {rlen})
                           (i32.const 8192) (i32.const 8192)))
            (if (i64.gt_s (local.get $n) (i64.const 0))
              (then (call $log (i32.const 1) (i32.const 8192)
                               (i32.wrap_i64 (local.get $n)))))
            (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n)))
            (local.get $p))
          (func (export "plugin_free") (param i32 i32))
          (func (export "plugin_describe") (param $o i32) (param $c i32) (result i64)
            (local $i i32) (local.set $i (i32.const 0))
            (block $d (loop $l
              (br_if $d (i32.ge_s (local.get $i) (i32.const {dlen})))
              (i32.store8 (i32.add (local.get $o) (local.get $i))
                (i32.load8_u (i32.add (i32.const 600) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $l)))
            (i64.const {dlen}))
          (func (export "plugin_invoke")
            (param i32 i32 i32 i32) (param i32 i32) (result i64) (i64.const 0))
        )"#,
        req = req,
        rlen = req.len(),
        decl = decl,
        dlen = decl.len(),
    );
    wat::parse_str(&wat).expect("http probe should parse")
}

fn wasm_http_tool_probe(url: &str, requested_host: &str) -> Vec<u8> {
    let req = serde_json::json!({ "url": url }).to_string();
    let decl = serde_json::json!({
        "name": "sandbox-fetcher",
        "abi": 1,
        "tools": [{ "name": "sandbox_fetch", "description": "t", "exec": "go" }],
        "capabilities": { "network": { "allow": [requested_host] } }
    })
    .to_string();
    let result = r#"{"kind":"success","content":"done","value":{}}"#;
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (import "host" "http_fetch"
            (func $fetch (param i32 i32 i32 i32) (result i64)))
          (memory (export "memory") 4)
          (global $bump (mut i32) (i32.const 16384))
          (data (i32.const 100) {req:?})
          (data (i32.const 900) {decl:?})
          (data (i32.const 2200) {result:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
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
          (func (export "plugin_describe") (param $o i32) (param $c i32) (result i64)
            (call $blit (i32.const 900) (i32.const {dlen}) (local.get $o) (local.get $c)))
          (func (export "plugin_invoke")
            (param i32 i32 i32 i32) (param $o i32) (param $c i32) (result i64)
            (local $n i64)
            (local.set $n
              (call $fetch (i32.const 100) (i32.const {rlen})
                           (i32.const 8192) (i32.const 8192)))
            (if (i64.gt_s (local.get $n) (i64.const 0))
              (then (call $log (i32.const 1) (i32.const 8192)
                               (i32.wrap_i64 (local.get $n)))))
            (call $blit (i32.const 2200) (i32.const {olen}) (local.get $o) (local.get $c)))
        )"#,
        req = req,
        rlen = req.len(),
        decl = decl,
        dlen = decl.len(),
        result = result,
        olen = result.len(),
    );
    wat::parse_str(&wat).expect("sandbox http probe should parse")
}

#[test]
fn http_fetch_performs_a_real_request_and_returns_the_body() {
    // The network capability, proven end to end: a plugin asks the host to fetch
    // a URL, the host makes the request, and the guest sees status + body.
    // WASI p1's own sockets are unimplemented stubs, so this import is the only
    // way a plugin reaches the network.
    use std::io::{Read, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((mut sock, _)) = listener.accept() {
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf);
            let body = "HELLO_FROM_LOCAL_SERVER";
            let _ = sock.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            );
        }
    });

    let dir = tmpdir("http-real");
    let wasm = dir.join("p.wasm");
    write(
        &wasm,
        &wasm_http_probe(&format!("http://127.0.0.1:{port}/")),
    );

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load("fetcher", &wasm, serde_json::Value::Null)
        .expect("a plugin may use host.http_fetch");

    let reply = reg
        .logs()
        .into_iter()
        .map(|r| r.message)
        .find(|m| m.starts_with('{'))
        .expect("the guest should have logged the fetch reply");
    let v: serde_json::Value = serde_json::from_str(&reply).expect("reply is JSON");
    assert_eq!(v["status"], 200, "reply: {reply}");
    assert_eq!(v["body"], "HELLO_FROM_LOCAL_SERVER", "reply: {reply}");
}

#[test]
fn http_fetch_reports_an_error_for_an_unreachable_host() {
    // Network failure must be a JSON error the plugin can handle, never a trap.
    let dir = tmpdir("http-fail");
    let wasm = dir.join("p.wasm");
    write(&wasm, &wasm_http_probe("http://127.0.0.1:1/nope"));

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load("fetcher", &wasm, serde_json::Value::Null)
        .expect("must not trap on an unreachable host");

    let reply = reg
        .logs()
        .into_iter()
        .map(|r| r.message)
        .find(|m| m.starts_with('{'))
        .expect("the guest should have logged the fetch reply");
    assert!(
        reply.contains("error"),
        "an unreachable host must yield a JSON error, got: {reply}"
    );
}

#[test]
fn sandboxed_http_fetch_denies_a_host_that_was_not_granted() {
    let dir = tmpdir("http-sandbox-deny");
    let wasm = dir.join("p.wasm");
    write(
        &wasm,
        &wasm_http_tool_probe("http://127.0.0.1:1/nope", "127.0.0.1"),
    );

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "fetcher",
        &wasm,
        serde_json::Value::Null,
        PluginPolicy {
            trust: TrustMode::Sandboxed,
            ..Default::default()
        },
    )
    .unwrap();
    reg.call_tool("sandbox_fetch", &serde_json::json!({}))
        .unwrap();

    let reply = reg
        .logs()
        .into_iter()
        .map(|r| r.message)
        .find(|m| m.contains("permission denied"))
        .expect("denied fetch should be returned to and logged by the guest");
    assert!(reply.contains("127.0.0.1"), "reply: {reply}");

    let audit = reg.audit_events_for("fetcher");
    let denied = audit
        .iter()
        .find(|event| {
            event.capability == "network.http"
                && event.decision == wasm_plugin_host::AuditDecision::Deny
        })
        .expect("network denial should be present in the host audit stream");
    assert!(denied.target.contains("127.0.0.1"), "audit: {denied:?}");
    assert!(
        denied
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("permission denied"),
        "audit: {denied:?}"
    );
}

#[test]
fn wildcard_network_capability_does_not_authorize_loopback_ip_literal() {
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();

    let dir = tmpdir("http-sandbox-wildcard-loopback");
    let wasm = dir.join("p.wasm");
    write(
        &wasm,
        &wasm_http_tool_probe(&format!("http://127.0.0.1:{port}/"), "*"),
    );

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "fetcher",
        &wasm,
        serde_json::Value::Null,
        PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                network: NetworkCapabilities {
                    allow: vec!["*".into()],
                    methods: vec!["GET".into()],
                },
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .unwrap();
    reg.call_tool("sandbox_fetch", &serde_json::json!({}))
        .unwrap();

    let reply = reg
        .logs()
        .into_iter()
        .map(|r| r.message)
        .find(|m| m.contains("sensitive targets require an exact host grant"))
        .expect("loopback IP literal should be denied before any socket is opened");
    assert!(reply.contains("127.0.0.1"), "reply: {reply}");

    let err = listener
        .accept()
        .expect_err("denied request must not reach the loopback listener");
    assert_eq!(err.kind(), std::io::ErrorKind::WouldBlock);
}

#[test]
fn sandboxed_http_fetch_allows_request_intersect_grant() {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((mut sock, _)) = listener.accept() {
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf);
            let body = "SANDBOX_OK";
            let _ = sock.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            );
        }
    });

    let dir = tmpdir("http-sandbox-allow");
    let wasm = dir.join("p.wasm");
    write(
        &wasm,
        &wasm_http_tool_probe(&format!("http://127.0.0.1:{port}/"), "127.0.0.1"),
    );

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "fetcher",
        &wasm,
        serde_json::Value::Null,
        PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                network: NetworkCapabilities {
                    allow: vec!["127.0.0.1".into()],
                    methods: vec!["GET".into()],
                },
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .unwrap();
    reg.call_tool("sandbox_fetch", &serde_json::json!({}))
        .unwrap();

    let reply = reg
        .logs()
        .into_iter()
        .map(|r| r.message)
        .find(|m| m.contains("SANDBOX_OK"))
        .expect("granted fetch should reach the local server");
    assert!(reply.contains("\"status\":200"), "reply: {reply}");

    assert!(
        reg.audit_events_for("fetcher").iter().any(|event| {
            event.capability == "network.http"
                && event.decision == wasm_plugin_host::AuditDecision::Allow
        }),
        "successful capability use should also be auditable"
    );
}

#[test]
fn sandboxed_http_fetch_does_not_follow_redirects_past_the_capability_gate() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let redirected_to = TcpListener::bind("127.0.0.1:0").unwrap();
    let redirected_port = redirected_to.local_addr().unwrap().port();
    let redirected_hit = Arc::new(AtomicBool::new(false));
    let redirected_hit_thread = redirected_hit.clone();
    std::thread::spawn(move || {
        if let Ok((mut sock, _)) = redirected_to.accept() {
            redirected_hit_thread.store(true, Ordering::SeqCst);
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf);
            let body = "SHOULD_NOT_BE_REACHED";
            let _ = sock.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            );
        }
    });

    let redirector = TcpListener::bind("127.0.0.1:0").unwrap();
    let redirector_port = redirector.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((mut sock, _)) = redirector.accept() {
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf);
            let location = format!("http://localhost:{redirected_port}/secret");
            let _ = sock.write_all(
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            );
        }
    });

    let dir = tmpdir("http-sandbox-redirect");
    let wasm = dir.join("p.wasm");
    write(
        &wasm,
        &wasm_http_tool_probe(
            &format!("http://127.0.0.1:{redirector_port}/"),
            "127.0.0.1",
        ),
    );

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "fetcher",
        &wasm,
        serde_json::Value::Null,
        PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                network: NetworkCapabilities {
                    allow: vec!["127.0.0.1".into()],
                    methods: vec!["GET".into()],
                },
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .unwrap();
    reg.call_tool("sandbox_fetch", &serde_json::json!({}))
        .unwrap();

    std::thread::sleep(std::time::Duration::from_millis(100));
    assert!(
        !redirected_hit.load(Ordering::SeqCst),
        "the HTTP client must not follow an allowed URL to an unvalidated redirect host"
    );

    let reply = reg
        .logs()
        .into_iter()
        .map(|r| r.message)
        .find(|m| m.contains("\"status\":302"))
        .expect(
            "guest should receive the redirect response and decide whether to request the next URL",
        );
    assert!(reply.contains("location"), "reply: {reply}");
}

#[test]
fn trusted_http_fetch_keeps_legacy_redirect_behavior() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    let target_port = target.local_addr().unwrap().port();
    let target_hit = Arc::new(AtomicBool::new(false));
    let target_hit_thread = target_hit.clone();
    std::thread::spawn(move || {
        if let Ok((mut sock, _)) = target.accept() {
            target_hit_thread.store(true, Ordering::SeqCst);
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf);
            let body = "TRUSTED_REDIRECT_OK";
            let _ = sock.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            );
        }
    });

    let redirector = TcpListener::bind("127.0.0.1:0").unwrap();
    let redirector_port = redirector.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((mut sock, _)) = redirector.accept() {
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf);
            let location = format!("http://127.0.0.1:{target_port}/final");
            let _ = sock.write_all(
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            );
        }
    });

    let dir = tmpdir("http-trusted-redirect");
    let wasm = dir.join("p.wasm");
    write(
        &wasm,
        &wasm_http_probe(&format!("http://127.0.0.1:{redirector_port}/")),
    );

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load("fetcher", &wasm, serde_json::Value::Null)
        .expect("trusted compatibility mode should still follow redirects");

    assert!(
        target_hit.load(Ordering::SeqCst),
        "trusted mode should retain the historical automatic redirect behavior"
    );
    assert!(
        reg.logs()
            .iter()
            .any(|record| record.message.contains("TRUSTED_REDIRECT_OK")),
        "trusted redirected response should reach the guest"
    );
}
