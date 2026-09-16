//! Demonstrate the service graph: **responsive convergence** + **cross-plugin
//! service calls**.
//!
//! Two plugins:
//!   * `kv`     — provides a `kv` service (a tool whose exec returns a canned reply)
//!   * `report` — injects `kv` and, when active, exposes a tool that calls the
//!                `kv` service through `host.call_service`
//!
//! We load `report` first: it is quiescent (its inject is unmet). Then we load
//! `kv`, and `report` **activates automatically** — a cascade. Finally we unload
//! `kv` and watch `report` deactivate again.
//!
//! Run: cargo run --release --example services

use wasm_plugin_host::{Registry, Runtime};

fn main() -> anyhow::Result<()> {
    let mut reg = Registry::new(Runtime::new()?);

    let kv = write("kv", service_plugin("kv", "[]", r#"["kv"]"#, true,
        r#"{"kind":"success","content":"value-from-kv","value":{"k":"v"}}"#))?;
    let report = write("report", caller_plugin("report", r#"["kv"]"#, "report_tool", "get"))?;

    println!("== load `report` first (injects kv, unmet) ==");
    let r = reg.load("report", &report, serde_json::Value::Null)?;
    println!("  active={}  missing={:?}  tools={:?}", r.active, r.missing_services, r.tools);
    println!("  report_tool registered? {}", reg.tool_owner("report_tool").is_some());

    println!("\n== load `kv` (provides kv) -> cascade ==");
    let r = reg.load("kv", &kv, serde_json::Value::Null)?;
    println!("  kv active={}", r.active);
    println!("  report now active? {}", reg.is_active("report"));
    println!("  report_tool registered? {}", reg.tool_owner("report_tool").is_some());

    println!("\n== call report_tool -> it calls the kv service ==");
    let out = reg.call_tool("report_tool", &serde_json::json!({}))?;
    println!("  {}", serde_json::to_string(&out)?);

    println!("\n== unload `kv` -> cascade deactivates report ==");
    reg.unload("kv")?;
    println!("  report active? {}", reg.is_active("report"));
    println!("  report_tool registered? {}", reg.tool_owner("report_tool").is_some());
    Ok(())
}

/// A plugin providing a service, optionally with a tool.
fn service_plugin(slot: &str, injects: &str, provides: &str, tool: bool, reply: &str) -> Vec<u8> {
    let tools = if tool {
        format!(r#"[{{"name":"{slot}_t","description":"d","exec":"go"}}]"#)
    } else { "[]".into() };
    let decl = format!(r#"{{"name":"{slot}","abi":1,"tools":{tools},"injects":{injects},"provides":{provides}}}"#);
    build(&decl, reply, None)
}

/// A plugin that injects a service and whose tool calls it.
fn caller_plugin(slot: &str, injects: &str, tool: &str, op: &str) -> Vec<u8> {
    let decl = format!(r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{tool}","description":"d","exec":"go"}}],"injects":{injects}}}"#);
    build(&decl, "", Some(("kv", op)))
}

fn build(decl: &str, reply: &str, svc: Option<(&str, &str)>) -> Vec<u8> {
    let decl_off = 64usize;
    let res_off = decl_off + decl.len();
    let (svc_off, op_off) = (res_off + reply.len() + 8, res_off + reply.len() + 64);
    let (svc, op) = svc.unwrap_or(("", ""));
    let has_call = !svc.is_empty();
    let call_impl = if has_call {
        format!(r#"(call $call (i32.const {svc_off}) (i32.const {}) (i32.const {op_off}) (i32.const {}) (i32.const 0) (i32.const 0) (local.get $o) (local.get $c))"#, svc.len(), op.len())
    } else {
        format!("(call $blit (i32.const {res_off}) (i32.const {}) (local.get $o) (local.get $c))", reply.len())
    };
    let import = if has_call {
        r#"(import "host" "call_service" (func $call (param i32 i32 i32 i32 i32 i32 i32 i32) (result i64)))"#
    } else { "" };
    let wat = format!(r#"(module
      (import "host" "log" (func $log (param i32 i32 i32)))
      {import}
      (memory (export "memory") 4)
      (global $bump (mut i32) (i32.const 16384))
      (data (i32.const {decl_off}) {decl:?})
      (data (i32.const {res_off}) {reply:?})
      (data (i32.const {svc_off}) {svc:?})
      (data (i32.const {op_off}) {op:?})
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
        {call_impl})
    )"#, decl_off=decl_off, res_off=res_off, svc_off=svc_off, op_off=op_off,
        decl=decl, reply=reply, svc=svc, op=op, dlen=decl.len(),
        import=import, call_impl=call_impl);
    wat::parse_str(&wat).expect("wat")
}

fn write(name: &str, bytes: Vec<u8>) -> anyhow::Result<std::path::PathBuf> {
    let mut p = std::env::temp_dir();
    p.push(format!("svc-demo-{name}.wasm"));
    std::fs::write(&p, bytes)?;
    Ok(p)
}
