//! Phase-C capability tests for services and hooks.

use std::path::PathBuf;
use wasm_plugin_host::{
    AgentCapabilities, CapabilitySet, PluginPolicy, Registry, Runtime, ServiceCapabilities,
    TrustMode, UiCapabilities,
};

fn tmpdir(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "wasm-plugin-cap-phase-c-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn write(path: &std::path::Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
}

fn declaration_guest(decl: &str, reply: &str) -> Vec<u8> {
    let decl_off = 64usize;
    let reply_off = decl_off + decl.len() + 64;
    let wat = format!(
        r#"(module
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 8192))
          (data (i32.const {decl_off}) {decl:?})
          (data (i32.const {reply_off}) {reply:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n)))
            (local.get $p))
          (func (export "plugin_free") (param i32 i32))
          (func $blit
            (param $src i32) (param $len i32) (param $out i32) (param $cap i32)
            (result i64)
            (local $i i32)
            (if (i32.lt_s (local.get $cap) (local.get $len))
              (then
                (return
                  (i64.extend_i32_s
                    (i32.sub (i32.const 0) (local.get $len))))))
            (block $done
              (loop $copy
                (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
                (i32.store8
                  (i32.add (local.get $out) (local.get $i))
                  (i32.load8_u
                    (i32.add (i32.const {decl_off}) (local.get $i))))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $copy)))
            (i64.extend_i32_s (local.get $len)))
          (func (export "plugin_describe") (param $out i32) (param $cap i32) (result i64)
            (call $blit_decl (local.get $out) (local.get $cap)))
          (func $blit_decl (param $out i32) (param $cap i32) (result i64)
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
            (param i32 i32 i32 i32) (param $out i32) (param $cap i32) (result i64)
            (local $i i32)
            (if (i32.lt_s (local.get $cap) (i32.const {rlen}))
              (then
                (return
                  (i64.extend_i32_s
                    (i32.sub (i32.const 0) (i32.const {rlen}))))))
            (block $done
              (loop $copy
                (br_if $done (i32.ge_s (local.get $i) (i32.const {rlen})))
                (i32.store8
                  (i32.add (local.get $out) (local.get $i))
                  (i32.load8_u
                    (i32.add (i32.const {reply_off}) (local.get $i))))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $copy)))
            (i64.const {rlen}))
        )"#,
        decl_off = decl_off,
        reply_off = reply_off,
        decl = decl,
        reply = reply,
        dlen = decl.len(),
        rlen = reply.len(),
    );
    wat::parse_str(wat).unwrap()
}

fn direct_service_caller_guest(service: &str) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"caller","abi":1,"tools":[{{"name":"caller_tool","description":"t","exec":"go"}}],"capabilities":{{"services":{{"consume":["{service}"]}}}}}}"#
    );
    let svc_off = 64usize;
    let decl_off = 256usize;
    let wat = format!(
        r#"(module
          (import "host" "call_service"
            (func $call (param i32 i32 i32 i32 i32 i32 i32 i32) (result i64)))
          (memory (export "memory") 4)
          (global $bump (mut i32) (i32.const 16384))
          (data (i32.const {svc_off}) {service:?})
          (data (i32.const {decl_off}) {decl:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
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
              (then (return (i64.extend_i32_s (i32.sub (i32.const 0) (i32.const {dlen}))))))
            (block $done (loop $copy
              (br_if $done (i32.ge_s (local.get $i) (i32.const {dlen})))
              (i32.store8
                (i32.add (local.get $out) (local.get $i))
                (i32.load8_u (i32.add (i32.const {decl_off}) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $copy)))
            (i64.const {dlen}))
          (func (export "plugin_invoke")
            (param i32 i32 i32 i32) (param $out i32) (param $cap i32) (result i64)
            (call $call
              (i32.const {svc_off}) (i32.const {svclen})
              (i32.const 0) (i32.const 0)
              (i32.const 0) (i32.const 0)
              (local.get $out) (local.get $cap)))
        )"#,
        svc_off = svc_off,
        decl_off = decl_off,
        service = service,
        decl = decl,
        svclen = service.len(),
        dlen = decl.len(),
    );
    wat::parse_str(wat).unwrap()
}

fn sandbox(grant: CapabilitySet) -> PluginPolicy {
    PluginPolicy {
        trust: TrustMode::Sandboxed,
        grant,
        ..Default::default()
    }
}

#[test]
fn direct_service_call_is_denied_at_runtime_without_grant() {
    let dir = tmpdir("runtime-consume-deny");
    let path = dir.join("p.wasm");
    write(&path, &direct_service_caller_guest("kv"));

    // The plugin requests consume capability but deliberately does not declare
    // an inject, so load-time dependency validation cannot be the only defense.
    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "caller",
        &path,
        serde_json::Value::Null,
        sandbox(CapabilitySet::default()),
    )
    .unwrap();

    let out = reg
        .call_tool("caller_tool", &serde_json::json!({}))
        .unwrap();
    assert_eq!(out["kind"], "error");
    assert!(
        out["message"]
            .as_str()
            .unwrap_or("")
            .contains("service consume"),
        "reply: {out}"
    );
}

#[test]
fn sandboxed_service_provide_requires_request_and_grant() {
    let dir = tmpdir("provide");
    let path = dir.join("p.wasm");
    let decl = r#"{
      "name":"provider","abi":1,"tools":[],
      "provides":["kv"],
      "capabilities":{"services":{"provide":["kv"]}}
    }"#;
    write(&path, &declaration_guest(decl, r#"{"kind":"success"}"#));

    let mut denied = Registry::new(Runtime::new().unwrap());
    let err = denied
        .load_with_policy(
            "provider",
            &path,
            serde_json::Value::Null,
            sandbox(CapabilitySet::default()),
        )
        .unwrap_err();
    assert!(err.to_string().contains("service provide"), "got: {err}");

    let mut allowed = Registry::new(Runtime::new().unwrap());
    allowed
        .load_with_policy(
            "provider",
            &path,
            serde_json::Value::Null,
            sandbox(CapabilitySet {
                services: ServiceCapabilities {
                    provide: vec!["kv".into()],
                    ..Default::default()
                },
                ..Default::default()
            }),
        )
        .unwrap();
    assert_eq!(allowed.provider_of("kv").as_deref(), Some("provider"));
}

#[test]
fn sandboxed_service_consume_requires_request_and_grant() {
    let dir = tmpdir("consume");
    let path = dir.join("p.wasm");
    let decl = r#"{
      "name":"consumer","abi":1,"tools":[],
      "injects":["kv"],
      "capabilities":{"services":{"consume":["kv"]}}
    }"#;
    write(&path, &declaration_guest(decl, r#"{"kind":"success"}"#));

    let mut denied = Registry::new(Runtime::new().unwrap());
    let err = denied
        .load_with_policy(
            "consumer",
            &path,
            serde_json::Value::Null,
            sandbox(CapabilitySet::default()),
        )
        .unwrap_err();
    assert!(err.to_string().contains("service consume"), "got: {err}");

    let mut allowed = Registry::new(Runtime::new().unwrap());
    let report = allowed
        .load_with_policy(
            "consumer",
            &path,
            serde_json::Value::Null,
            sandbox(CapabilitySet {
                services: ServiceCapabilities {
                    consume: vec!["kv".into()],
                    ..Default::default()
                },
                ..Default::default()
            }),
        )
        .unwrap();
    assert!(!report.active);
    assert_eq!(report.missing_services, vec!["kv"]);
}

#[test]
fn sandboxed_observe_hook_requires_observe_capability() {
    let dir = tmpdir("observe-hook");
    let path = dir.join("p.wasm");
    let decl = r#"{
      "name":"observer","abi":1,"tools":[],
      "hooks":[{"on":"turn/start","exec":"watch","mode":"observe"}],
      "capabilities":{"agent":{"observe":["turn/start"]}}
    }"#;
    write(&path, &declaration_guest(decl, r#"{"kind":"continue"}"#));

    let mut denied = Registry::new(Runtime::new().unwrap());
    let err = denied
        .load_with_policy(
            "observer",
            &path,
            serde_json::Value::Null,
            sandbox(CapabilitySet::default()),
        )
        .unwrap_err();
    assert!(err.to_string().contains("agent observe"), "got: {err}");

    let mut allowed = Registry::new(Runtime::new().unwrap());
    let report = allowed
        .load_with_policy(
            "observer",
            &path,
            serde_json::Value::Null,
            sandbox(CapabilitySet {
                agent: AgentCapabilities {
                    observe: vec!["turn/start".into()],
                    ..Default::default()
                },
                ..Default::default()
            }),
        )
        .unwrap();
    assert_eq!(report.hooks.len(), 1);
}

#[test]
fn sandboxed_ui_route_requires_request_and_grant() {
    let dir = tmpdir("ui-route");
    let path = dir.join("p.wasm");
    let decl = r#"{
      "name":"ui-plugin","abi":1,"tools":[],
      "ui":{
        "assets":{"entry.js":"register('Page', {})"},
        "routes":[{"path":"usage","component":"Page","nav":false}]
      },
      "capabilities":{"ui":{"routes":["usage"]}}
    }"#;
    write(&path, &declaration_guest(decl, r#"{"kind":"success"}"#));

    let mut denied = Registry::new(Runtime::new().unwrap());
    let err = denied
        .load_with_policy(
            "ui",
            &path,
            serde_json::Value::Null,
            sandbox(CapabilitySet::default()),
        )
        .unwrap_err();
    assert!(err.to_string().contains("ui route"), "got: {err}");

    let mut allowed = Registry::new(Runtime::new().unwrap());
    allowed
        .load_with_policy(
            "ui",
            &path,
            serde_json::Value::Null,
            sandbox(CapabilitySet {
                ui: UiCapabilities {
                    routes: vec!["usage".into()],
                    ..Default::default()
                },
                ..Default::default()
            }),
        )
        .unwrap();
}

#[test]
fn sandboxed_ui_assets_without_any_ui_capability_are_rejected() {
    let dir = tmpdir("ui-assets");
    let path = dir.join("p.wasm");
    let decl = r#"{
      "name":"assets-only","abi":1,"tools":[],
      "ui":{"assets":{"entry.js":"sideEffect()"}}
    }"#;
    write(&path, &declaration_guest(decl, r#"{"kind":"success"}"#));

    let mut reg = Registry::new(Runtime::new().unwrap());
    let err = reg
        .load_with_policy(
            "ui",
            &path,
            serde_json::Value::Null,
            sandbox(CapabilitySet::default()),
        )
        .unwrap_err();
    assert!(err.to_string().contains("UI assets"), "got: {err}");
}

#[test]
fn rewrite_only_event_requires_only_rewrite_capability() {
    let dir = tmpdir("rewrite-only-hook");
    let path = dir.join("p.wasm");
    let decl = r#"{
      "name":"chunker","abi":1,"tools":[],
      "hooks":[{"on":"assistant/chunk","exec":"rewrite","mode":"waterfall"}],
      "capabilities":{"agent":{"rewrite":["assistant/chunk"]}}
    }"#;
    write(&path, &declaration_guest(decl, r#"{"kind":"continue"}"#));

    let mut reg = Registry::new(Runtime::new().unwrap());
    let report = reg
        .load_with_policy(
            "chunker",
            &path,
            serde_json::Value::Null,
            sandbox(CapabilitySet {
                agent: AgentCapabilities {
                    rewrite: vec!["assistant/chunk".into()],
                    ..Default::default()
                },
                ..Default::default()
            }),
        )
        .unwrap();
    assert_eq!(report.hooks.len(), 1);
}

#[test]
fn sandboxed_waterfall_hook_requires_rewrite_and_veto() {
    let dir = tmpdir("waterfall-hook");
    let path = dir.join("p.wasm");
    let decl = r#"{
      "name":"guard","abi":1,"tools":[],
      "hooks":[{"on":"tools/pre-execute","exec":"guard","mode":"waterfall"}],
      "capabilities":{
        "agent":{
          "rewrite":["tools/pre-execute"],
          "veto":["tools/pre-execute"]
        }
      }
    }"#;
    write(&path, &declaration_guest(decl, r#"{"kind":"continue"}"#));

    let mut missing_veto = Registry::new(Runtime::new().unwrap());
    let err = missing_veto
        .load_with_policy(
            "guard",
            &path,
            serde_json::Value::Null,
            sandbox(CapabilitySet {
                agent: AgentCapabilities {
                    rewrite: vec!["tools/pre-execute".into()],
                    ..Default::default()
                },
                ..Default::default()
            }),
        )
        .unwrap_err();
    assert!(err.to_string().contains("agent veto"), "got: {err}");

    let mut allowed = Registry::new(Runtime::new().unwrap());
    let report = allowed
        .load_with_policy(
            "guard",
            &path,
            serde_json::Value::Null,
            sandbox(CapabilitySet {
                agent: AgentCapabilities {
                    rewrite: vec!["tools/pre-execute".into()],
                    veto: vec!["tools/pre-execute".into()],
                    ..Default::default()
                },
                ..Default::default()
            }),
        )
        .unwrap();
    assert_eq!(report.hooks.len(), 1);
}
