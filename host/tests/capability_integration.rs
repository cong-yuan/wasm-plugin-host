//! End-to-end capability enforcement at plugin declaration load time.
//!
//! These tests intentionally use real WAT guests so a future refactor cannot
//! accidentally bypass Plugin::validate_declared_capabilities().

use std::path::PathBuf;
use wasm_plugin_host::{
    AgentCapabilities, AuditDecision, CapabilitySet, PluginPolicy, Registry, Runtime,
    ServiceCapabilities, TrustMode, UiCapabilities, UiHostAction,
};

fn tmpdir(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "wasm-plugin-capability-integration-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn declaration_guest(decl: serde_json::Value) -> Vec<u8> {
    let decl = serde_json::to_string(&decl).unwrap();
    let reply = r#"{"kind":"success","content":"ok","value":{}}"#;
    let decl_off = 256usize;
    let reply_off = 4096usize;
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
          (func (export "plugin_free") (param $p i32) (param $n i32)
            (global.set $bump (local.get $p)))

          (func $blit (param $src i32) (param $len i32)
                      (param $out i32) (param $cap i32) (result i64)
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
                  (i32.load8_u (i32.add (local.get $src) (local.get $i))))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $copy)))
            (i64.extend_i32_s (local.get $len)))

          (func (export "plugin_describe")
                (param $out i32) (param $cap i32) (result i64)
            (call $blit
              (i32.const {decl_off}) (i32.const {decl_len})
              (local.get $out) (local.get $cap)))

          (func (export "plugin_invoke")
                (param i32 i32 i32 i32)
                (param $out i32) (param $cap i32) (result i64)
            (call $blit
              (i32.const {reply_off}) (i32.const {reply_len})
              (local.get $out) (local.get $cap)))
        )"#,
        decl_off = decl_off,
        decl_len = decl.len(),
        decl = decl,
        reply_off = reply_off,
        reply_len = reply.len(),
        reply = reply,
    );
    wat::parse_str(wat).unwrap()
}

fn load(
    name: &str,
    decl: serde_json::Value,
    grant: CapabilitySet,
) -> Result<Registry, anyhow::Error> {
    let dir = tmpdir(name);
    let wasm = dir.join("p.wasm");
    std::fs::write(&wasm, declaration_guest(decl)).unwrap();

    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy(
        "cap",
        &wasm,
        serde_json::Value::Null,
        PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant,
            ..Default::default()
        },
    )?;
    Ok(reg)
}

#[test]
fn service_inject_needs_both_request_and_grant() {
    let decl = serde_json::json!({
        "name": "consumer",
        "abi": 1,
        "tools": [],
        "injects": ["kv"],
        "capabilities": {
            "services": { "consume": ["kv"] }
        }
    });

    let reg = load(
        "service-allow",
        decl.clone(),
        CapabilitySet {
            services: ServiceCapabilities {
                consume: vec!["kv".into()],
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .expect("request intersect grant should authorize the service declaration");
    assert_eq!(reg.provider_of("kv"), None);

    let err = match load(
        "service-deny-no-grant",
        decl,
        CapabilitySet::default(),
    ) {
        Ok(_) => panic!("service declaration should have been denied"),
        Err(err) => err,
    };
    let msg = err.to_string();
    assert!(msg.contains("service consume") && msg.contains("kv"), "got: {msg}");
}

#[test]
fn host_grant_alone_does_not_authorize_an_undeclared_service_capability() {
    let decl = serde_json::json!({
        "name": "consumer",
        "abi": 1,
        "tools": [],
        "injects": ["kv"]
    });

    let dir = tmpdir("service-deny-no-request");
    let wasm = dir.join("p.wasm");
    std::fs::write(&wasm, declaration_guest(decl)).unwrap();
    let mut reg = Registry::new(Runtime::new().unwrap());

    let err = reg
        .load_with_policy(
            "cap",
            &wasm,
            serde_json::Value::Null,
            PluginPolicy {
                trust: TrustMode::Sandboxed,
                grant: CapabilitySet {
                    services: ServiceCapabilities {
                        consume: vec!["kv".into()],
                        ..Default::default()
                    },
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap_err();

    assert!(err.to_string().contains("service consume"));
    assert!(reg.audit_events_for("cap").iter().any(|event| {
        event.decision == AuditDecision::Deny
            && event.capability == "services.consume"
            && event.target == "kv"
    }));
}

#[test]
fn waterfall_hook_needs_every_action_the_event_can_perform() {
    let decl = serde_json::json!({
        "name": "hook",
        "abi": 1,
        "tools": [],
        "hooks": [{
            "on": "tools/pre-execute",
            "exec": "hook",
            "mode": "waterfall"
        }],
        "capabilities": {
            "agent": {
                "rewrite": ["tools/pre-execute"],
                "veto": ["tools/pre-execute"]
            }
        }
    });

    let err = match load(
        "hook-partial-grant",
        decl.clone(),
        CapabilitySet {
            agent: AgentCapabilities {
                rewrite: vec!["tools/pre-execute".into()],
                ..Default::default()
            },
            ..Default::default()
        },
    ) {
        Ok(_) => panic!("partial waterfall grant should have been denied"),
        Err(err) => err,
    };
    assert!(
        err.to_string().contains("agent veto")
            && err.to_string().contains("tools/pre-execute"),
        "got: {err}"
    );

    load(
        "hook-full-grant",
        decl,
        CapabilitySet {
            agent: AgentCapabilities {
                rewrite: vec!["tools/pre-execute".into()],
                veto: vec!["tools/pre-execute".into()],
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .expect("full waterfall capability should load");
}

#[test]
fn ui_route_is_denied_without_the_matching_effective_capability() {
    let decl = serde_json::json!({
        "name": "ui",
        "abi": 1,
        "tools": [],
        "ui": {
            "routes": [{
                "path": "usage",
                "component": "Usage",
                "title": "Usage",
                "nav": true
            }]
        },
        "capabilities": {
            "ui": { "routes": ["usage"] }
        }
    });

    let err = match load("ui-route-deny", decl.clone(), CapabilitySet::default()) {
        Ok(_) => panic!("UI route should have been denied"),
        Err(err) => err,
    };
    assert!(
        err.to_string().contains("ui route") && err.to_string().contains("usage"),
        "got: {err}"
    );

    load(
        "ui-route-allow",
        decl,
        CapabilitySet {
            ui: UiCapabilities {
                routes: vec!["usage".into()],
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .expect("matching route request and grant should load");
}

#[test]
fn registry_frontend_authorization_uses_slot_effective_capabilities_and_audits() {
    let decl = serde_json::json!({
        "name": "frontend",
        "abi": 1,
        "tools": [],
        "ui": {
            "provides": [{ "name": "frontend.panel", "description": "panel" }],
            "windows": [{
                "name": "main",
                "component": "Main",
                "title": "Main"
            }]
        },
        "capabilities": {
            "ui": {
                "theme": true,
                "slots": ["frontend.panel"],
                "windows": true,
                "backend_commands": ["list_sessions"]
            }
        }
    });

    let reg = load(
        "frontend-runtime-auth",
        decl,
        CapabilitySet {
            ui: UiCapabilities {
                theme: true,
                slots: vec!["frontend.panel".into()],
                windows: true,
                backend_commands: vec!["list_sessions".into()],
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .unwrap();

    reg.authorize_ui_action(
        "cap",
        &UiHostAction::BackendCommand {
            command: "list_sessions".into(),
        },
    )
        .expect("requested and granted command should be allowed");
    reg.authorize_ui_action("cap", &UiHostAction::Theme)
        .expect("requested and granted theme should be allowed");
    reg.authorize_ui_action(
        "cap",
        &UiHostAction::RenderSlot {
            slot: "frontend.panel".into(),
        },
    )
    .expect("granted slot should be allowed at runtime");
    reg.authorize_ui_action(
        "cap",
        &UiHostAction::OpenWindow {
            name: "main".into(),
        },
    )
    .expect("declared window should be allowed at runtime");
    let err = reg
        .authorize_ui_action(
            "cap",
            &UiHostAction::BackendCommand {
                command: "run_shell".into(),
            },
        )
        .expect_err("ungranted command must be denied");
    assert!(err.to_string().contains("run_shell"));
    let err = reg
        .authorize_ui_action(
            "cap",
            &UiHostAction::OpenWindow {
                name: "undeclared".into(),
            },
        )
        .expect_err("window capability must not allow undeclared window names");
    assert!(err.to_string().contains("does not declare UI window"));

    let audit = reg.audit_events_for("cap");
    assert!(audit.iter().any(|event| {
        event.capability == "ui.backend_commands"
            && event.target == "list_sessions"
            && event.decision == AuditDecision::Allow
    }));
    assert!(audit.iter().any(|event| {
        event.capability == "ui.backend_commands"
            && event.target == "run_shell"
            && event.decision == AuditDecision::Deny
    }));
    assert!(audit.iter().any(|event| {
        event.capability == "ui.theme"
            && event.decision == AuditDecision::Allow
    }));
    assert!(audit.iter().any(|event| {
        event.capability == "ui.slots"
            && event.target == "frontend.panel"
            && event.decision == AuditDecision::Allow
    }));
    assert!(audit.iter().any(|event| {
        event.capability == "ui.windows"
            && event.target == "main"
            && event.decision == AuditDecision::Allow
    }));
}
