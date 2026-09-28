//! Phase-B resource-boundary integration tests.

use std::path::PathBuf;
use std::time::{Duration, Instant};
use wasm_plugin_host::{PluginPolicy, Registry, ResourceLimits, Runtime, TrustMode};

const RESULT: &str = r#"{"kind":"success","content":"ok","value":{}}"#;

fn tmpdir(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "wasm-plugin-resource-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn guest(invoke_body: &str) -> Vec<u8> {
    let decl = r#"{"name":"limits","abi":1,"tools":[{"name":"limits_tool","description":"t","exec":"go"}]}"#;
    let wat = format!(
        r#"(module
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 8192))
          (data (i32.const 64) {decl:?})
          (data (i32.const 2048) {result:?})
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
            (block $done (loop $copy
              (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
              (i32.store8 (i32.add (local.get $out) (local.get $i))
                (i32.load8_u (i32.add (local.get $src) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $copy)))
            (i64.extend_i32_s (local.get $len)))
          (func (export "plugin_describe") (param $o i32) (param $c i32) (result i64)
            (call $blit (i32.const 64) (i32.const {dlen}) (local.get $o) (local.get $c)))
          (func (export "plugin_invoke")
            (param i32 i32 i32 i32) (param $o i32) (param $c i32) (result i64)
            {invoke_body})
        )"#,
        decl = decl,
        dlen = decl.len(),
        result = RESULT,
        invoke_body = invoke_body,
    );
    wat::parse_str(wat).unwrap()
}

fn sandbox(limits: ResourceLimits) -> PluginPolicy {
    PluginPolicy {
        trust: TrustMode::Sandboxed,
        limits,
        ..Default::default()
    }
}

fn assert_limit_audit(reg: &Registry, capability: &str) {
    let events = reg.audit_events_for("limits");
    assert!(
        events.iter().any(|event| {
            event.decision == wasm_plugin_host::AuditDecision::Limit
                && event.capability == capability
        }),
        "expected audit limit event for {capability}, got: {events:?}"
    );
}

#[test]
fn fuel_exhaustion_terminates_a_busy_plugin() {
    let dir = tmpdir("fuel");
    let path = dir.join("p.wasm");
    std::fs::write(&path, guest(r#"(loop $spin (br $spin)) (i64.const 0)"#)).unwrap();

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "limits",
        &path,
        serde_json::Value::Null,
        sandbox(ResourceLimits {
            fuel: 50_000,
            call_timeout_ms: 5_000,
            ..Default::default()
        }),
    )
    .unwrap();

    let started = Instant::now();
    let err = reg
        .call_tool("limits_tool", &serde_json::json!({}))
        .unwrap_err();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "fuel exhaustion should terminate promptly"
    );
    let detail = err
        .chain()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(" | ")
        .to_ascii_lowercase();
    assert!(
        detail.contains("fuel")
            || detail.contains("interrupt")
            || detail.contains("wasm backtrace"),
        "expected a fuel/interrupt execution failure, got: {detail}"
    );
    assert_limit_audit(&reg, "limits.fuel");
}

#[test]
fn memory_growth_is_stopped_at_the_store_limit() {
    let dir = tmpdir("memory");
    let path = dir.join("p.wasm");
    std::fs::write(
        &path,
        guest(&format!(
            "(drop (memory.grow (i32.const 1000))) (call $blit (i32.const 2048) (i32.const {}) (local.get $o) (local.get $c))",
            RESULT.len()
        )),
    )
    .unwrap();

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "limits",
        &path,
        serde_json::Value::Null,
        sandbox(ResourceLimits {
            memory_mb: 1,
            ..Default::default()
        }),
    )
    .unwrap();

    let err = reg
        .call_tool("limits_tool", &serde_json::json!({}))
        .unwrap_err();
    let detail = err
        .chain()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(" | ")
        .to_ascii_lowercase();
    assert!(
        detail.contains("memory")
            || detail.contains("grow")
            || detail.contains("limit")
            || detail.contains("wasm backtrace"),
        "expected memory limiter failure, got: {detail}"
    );
    assert_limit_audit(&reg, "limits.memory_mb");
}

#[test]
fn output_larger_than_the_policy_cap_is_rejected() {
    let dir = tmpdir("output");
    let path = dir.join("p.wasm");
    std::fs::write(&path, guest("(i64.const -4096)")).unwrap();

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "limits",
        &path,
        serde_json::Value::Null,
        sandbox(ResourceLimits {
            max_output_bytes: 1024,
            ..Default::default()
        }),
    )
    .unwrap();

    let err = reg
        .call_tool("limits_tool", &serde_json::json!({}))
        .unwrap_err();
    assert!(
        err.to_string().contains("4096") && err.to_string().contains("1024"),
        "expected output-cap error, got: {err}"
    );
    assert_limit_audit(&reg, "limits.max_output_bytes");
}

#[test]
fn epoch_deadline_enforces_wall_clock_timeout() {
    let dir = tmpdir("timeout");
    let path = dir.join("p.wasm");
    std::fs::write(&path, guest(r#"(loop $spin (br $spin)) (i64.const 0)"#)).unwrap();

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "limits",
        &path,
        serde_json::Value::Null,
        sandbox(ResourceLimits {
            fuel: u64::MAX,
            call_timeout_ms: 50,
            ..Default::default()
        }),
    )
    .unwrap();

    let started = Instant::now();
    let err = reg
        .call_tool("limits_tool", &serde_json::json!({}))
        .unwrap_err();
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "epoch deadline should interrupt the guest, elapsed={elapsed:?}"
    );
    assert!(
        elapsed >= Duration::from_millis(10),
        "deadline should not trap immediately, elapsed={elapsed:?}; error={err}"
    );
    assert_limit_audit(&reg, "limits.call_timeout_ms");
}
