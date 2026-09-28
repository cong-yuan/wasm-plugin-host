//! Fine-grained sandbox filesystem mutation tests.
//!
//! Direct WASI access stays read-only. write/create/delete are host-mediated
//! through `host.fs_op` and operate relative to a cap-std directory handle.

use std::path::PathBuf;
use wasm_plugin_host::{
    AuditDecision, CapabilitySet, FilesystemCapabilities, PluginPolicy, Registry, Runtime,
    TrustMode,
};

const TOOL_RESULT: &str = r#"{"kind":"success","content":"ok","value":{}}"#;

fn tmpdir(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "wasm-plugin-fs-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn fs_guest(req: serde_json::Value, requested: FilesystemCapabilities) -> Vec<u8> {
    let req = serde_json::to_string(&req).unwrap();
    let decl = serde_json::json!({
        "name": "fs-probe",
        "abi": 1,
        "tools": [{
            "name": "fs_tool",
            "description": "filesystem probe",
            "exec": "run"
        }],
        "capabilities": {
            "filesystem": requested
        }
    })
    .to_string();

    let d = 1024usize;
    let q = 8192usize;
    let result = 16384usize;
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (import "host" "fs_op" (func $fs (param i32 i32 i32 i32) (result i64)))
          (memory (export "memory") 8)
          (global $bump (mut i32) (i32.const 65536))
          (data (i32.const {d}) {decl:?})
          (data (i32.const {q}) {req:?})
          (data (i32.const {result}) {tool_result:?})

          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
          (func (export "plugin_shutdown"))

          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n)))
            (local.get $p))
          (func (export "plugin_free") (param i32 i32))

          (func $blit (param $src i32) (param $len i32)
                      (param $out i32) (param $cap i32) (result i64)
            (local $i i32)
            (if (i32.lt_s (local.get $cap) (local.get $len))
              (then
                (return (i64.extend_i32_s
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

          (func (export "plugin_describe") (param $out i32) (param $cap i32) (result i64)
            (call $blit (i32.const {d}) (i32.const {dlen})
              (local.get $out) (local.get $cap)))

          (func (export "plugin_invoke")
            (param i32 i32 i32 i32) (param $out i32) (param $cap i32) (result i64)
            (local $n i64)
            (local.set $n
              (call $fs
                (i32.const {q}) (i32.const {qlen})
                (i32.const 32768) (i32.const 16384)))
            (if (i64.gt_s (local.get $n) (i64.const 0))
              (then
                (call $log
                  (i32.const 1)
                  (i32.const 32768)
                  (i32.wrap_i64 (local.get $n)))))
            (call $blit (i32.const {result}) (i32.const {rlen})
              (local.get $out) (local.get $cap)))
        )"#,
        d = d,
        dlen = decl.len(),
        decl = decl,
        q = q,
        qlen = req.len(),
        req = req,
        result = result,
        rlen = TOOL_RESULT.len(),
        tool_result = TOOL_RESULT,
    );
    wat::parse_str(wat).unwrap()
}

fn policy(grant: FilesystemCapabilities) -> PluginPolicy {
    PluginPolicy {
        trust: TrustMode::Sandboxed,
        grant: CapabilitySet {
            filesystem: grant,
            ..Default::default()
        },
        ..Default::default()
    }
}

fn run(
    name: &str,
    wasm: &[u8],
    policy: PluginPolicy,
) -> (Registry, serde_json::Value) {
    let dir = tmpdir(&format!("guest-{name}"));
    let wasm_path = dir.join("p.wasm");
    std::fs::write(&wasm_path, wasm).unwrap();
    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load_with_policy("fs", &wasm_path, serde_json::Value::Null, policy)
        .unwrap();
    let value = reg
        .call_tool("fs_tool", &serde_json::json!({}))
        .expect("tool call should return its normal success envelope");
    (reg, value)
}

fn fs_reply(reg: &Registry) -> serde_json::Value {
    let message = reg
        .logs_for("fs")
        .into_iter()
        .map(|r| r.message)
        .find(|m| m.starts_with('{'))
        .expect("guest should log host.fs_op reply");
    serde_json::from_str(&message).expect("fs reply should be JSON")
}

#[test]
fn create_file_uses_create_capability_and_stays_below_root() {
    let root = tmpdir("create-root");
    let root_s = root.to_string_lossy().into_owned();
    let requested = FilesystemCapabilities {
        create: vec![root_s.clone()],
        ..Default::default()
    };
    let wasm = fs_guest(
        serde_json::json!({
            "op": "create_file",
            "root": root_s,
            "path": "new.txt",
            "data_b64": "SEVMTE8="
        }),
        requested.clone(),
    );
    let (reg, _) = run("create", &wasm, policy(requested));
    assert_eq!(std::fs::read(root.join("new.txt")).unwrap(), b"HELLO");
    assert_eq!(fs_reply(&reg)["ok"], true);
    assert!(reg.audit_events_for("fs").iter().any(|e| {
        e.decision == AuditDecision::Allow && e.capability == "filesystem.create"
    }));
}

#[test]
fn write_file_requires_write_and_does_not_create() {
    let root = tmpdir("write-root");
    std::fs::write(root.join("existing.txt"), b"OLD").unwrap();
    let root_s = root.to_string_lossy().into_owned();
    let requested = FilesystemCapabilities {
        write: vec![root_s.clone()],
        ..Default::default()
    };
    let wasm = fs_guest(
        serde_json::json!({
            "op": "write_file",
            "root": root_s,
            "path": "existing.txt",
            "data_b64": "TkVX"
        }),
        requested.clone(),
    );
    let (reg, _) = run("write", &wasm, policy(requested));
    assert_eq!(std::fs::read(root.join("existing.txt")).unwrap(), b"NEW");
    assert_eq!(fs_reply(&reg)["ok"], true);
    assert!(!root.join("other.txt").exists());
}

#[test]
fn write_file_does_not_implicitly_create_a_missing_file() {
    let root = tmpdir("write-no-create-root");
    let root_s = root.to_string_lossy().into_owned();
    let requested = FilesystemCapabilities {
        write: vec![root_s.clone()],
        ..Default::default()
    };
    let wasm = fs_guest(
        serde_json::json!({
            "op": "write_file",
            "root": root_s,
            "path": "missing.txt",
            "data_b64": "WA=="
        }),
        requested.clone(),
    );
    let (reg, _) = run("write-no-create", &wasm, policy(requested));
    assert!(!root.join("missing.txt").exists());
    assert!(fs_reply(&reg)["error"]
        .as_str()
        .unwrap_or("")
        .contains("write_file"));
}

#[cfg(unix)]
#[test]
fn write_file_cannot_escape_root_through_a_symlink() {
    use std::os::unix::fs::symlink;

    let root = tmpdir("write-symlink-root");
    let outside_dir = tmpdir("write-symlink-outside");
    let outside = outside_dir.join("outside.txt");
    std::fs::write(&outside, b"SAFE").unwrap();
    symlink(&outside, root.join("link.txt")).unwrap();

    let root_s = root.to_string_lossy().into_owned();
    let requested = FilesystemCapabilities {
        write: vec![root_s.clone()],
        ..Default::default()
    };
    let wasm = fs_guest(
        serde_json::json!({
            "op": "write_file",
            "root": root_s,
            "path": "link.txt",
            "data_b64": "UFdORUQ="
        }),
        requested.clone(),
    );
    let (reg, _) = run("write-symlink", &wasm, policy(requested));
    assert_eq!(std::fs::read(&outside).unwrap(), b"SAFE");
    assert!(fs_reply(&reg)["error"].is_string());
}

#[test]
fn delete_file_requires_delete_capability() {
    let root = tmpdir("delete-root");
    std::fs::write(root.join("gone.txt"), b"x").unwrap();
    let root_s = root.to_string_lossy().into_owned();
    let requested = FilesystemCapabilities {
        delete: vec![root_s.clone()],
        ..Default::default()
    };
    let wasm = fs_guest(
        serde_json::json!({
            "op": "delete_file",
            "root": root_s,
            "path": "gone.txt"
        }),
        requested.clone(),
    );
    let (reg, _) = run("delete", &wasm, policy(requested));
    assert!(!root.join("gone.txt").exists());
    assert_eq!(fs_reply(&reg)["ok"], true);
}

#[test]
fn create_and_delete_directory_use_distinct_capabilities() {
    let root = tmpdir("dir-ops-root");
    let root_s = root.to_string_lossy().into_owned();

    let create_requested = FilesystemCapabilities {
        create: vec![root_s.clone()],
        ..Default::default()
    };
    let create_wasm = fs_guest(
        serde_json::json!({
            "op": "create_dir",
            "root": root_s,
            "path": "child"
        }),
        create_requested.clone(),
    );
    let (create_reg, _) = run("create-dir", &create_wasm, policy(create_requested));
    assert!(root.join("child").is_dir());
    assert_eq!(fs_reply(&create_reg)["ok"], true);

    let root_s = root.to_string_lossy().into_owned();
    let delete_requested = FilesystemCapabilities {
        delete: vec![root_s.clone()],
        ..Default::default()
    };
    let delete_wasm = fs_guest(
        serde_json::json!({
            "op": "delete_dir",
            "root": root_s,
            "path": "child"
        }),
        delete_requested.clone(),
    );
    let (delete_reg, _) = run("delete-dir", &delete_wasm, policy(delete_requested));
    assert!(!root.join("child").exists());
    assert_eq!(fs_reply(&delete_reg)["ok"], true);
}

#[test]
fn grant_without_plugin_request_is_denied_and_audited() {
    let root = tmpdir("no-request-root");
    let root_s = root.to_string_lossy().into_owned();
    let wasm = fs_guest(
        serde_json::json!({
            "op": "create_file",
            "root": root_s,
            "path": "blocked.txt",
            "data_b64": "WA=="
        }),
        FilesystemCapabilities::default(),
    );
    let grant = FilesystemCapabilities {
        create: vec![root.to_string_lossy().into_owned()],
        ..Default::default()
    };
    let (reg, _) = run("no-request", &wasm, policy(grant));
    assert!(!root.join("blocked.txt").exists());
    let reply = fs_reply(&reg);
    assert!(reply["error"]
        .as_str()
        .unwrap_or("")
        .contains("permission denied"));
    assert!(reg.audit_events_for("fs").iter().any(|e| {
        e.decision == AuditDecision::Deny && e.capability == "filesystem.create"
    }));
}

#[test]
fn parent_traversal_is_rejected_before_filesystem_access() {
    let root = tmpdir("traversal-root");
    let escape_name = format!("escape-{}.txt", std::process::id());
    let outside = root.parent().unwrap().join(&escape_name);
    let _ = std::fs::remove_file(&outside);
    let root_s = root.to_string_lossy().into_owned();
    let requested = FilesystemCapabilities {
        create: vec![root_s.clone()],
        ..Default::default()
    };
    let wasm = fs_guest(
        serde_json::json!({
            "op": "create_file",
            "root": root_s,
            "path": format!("../{escape_name}"),
            "data_b64": "WA=="
        }),
        requested.clone(),
    );
    let (reg, _) = run("traversal", &wasm, policy(requested));
    assert!(!outside.exists());
    assert!(fs_reply(&reg)["error"]
        .as_str()
        .unwrap_or("")
        .contains("parent traversal"));
    assert!(reg.audit_events_for("fs").iter().any(|e| {
        e.decision == AuditDecision::Deny && e.capability == "filesystem.path"
    }));
}

#[test]
fn absolute_mutation_path_is_rejected() {
    let root = tmpdir("absolute-root");
    let root_s = root.to_string_lossy().into_owned();
    let requested = FilesystemCapabilities {
        create: vec![root_s.clone()],
        ..Default::default()
    };
    let wasm = fs_guest(
        serde_json::json!({
            "op": "create_file",
            "root": root_s,
            "path": "/tmp/should-not-be-created-by-fs-op",
            "data_b64": "WA=="
        }),
        requested.clone(),
    );
    let (reg, _) = run("absolute", &wasm, policy(requested));
    assert!(fs_reply(&reg)["error"]
        .as_str()
        .unwrap_or("")
        .contains("relative path"));
}
