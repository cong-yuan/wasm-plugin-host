//! Demonstrate: a WASM plugin **intervenes in the agent flow**.
//!
//! We build three plugins in-memory (as WASM) and run a turn:
//!   * `echo`  — a leaf tool the model calls
//!   * `guard` — a WATERFALL hook on `tools/pre-execute` that vetoes a bad call
//!   * `redact`— a WATERFALL hook on `agent/pre-step` that rewrites the input
//!
//! Then we drop the guard and show the same turn proceeds.
//!
//! Run: cargo run --release --example intervene

use wasm_plugin_host::{run_turn, Registry, Runtime, ScriptedModel};

/// Build a plugin with one tool, one hook, or both, whose invoke returns `reply`.
fn plugin(slot: &str, tool: bool, event: &str, mode: &str, reply: &str) -> Vec<u8> {
    let tools = if tool {
        format!(r#"[{{"name":"{slot}_tool","description":"echo","exec":"go"}}]"#)
    } else {
        "[]".to_string()
    };
    let hooks = if event.is_empty() {
        "[]".to_string()
    } else {
        format!(r#"[{{"on":"{event}","exec":"hook","mode":"{mode}"}}]"#)
    };
    let decl = format!(r#"{{"name":"{slot}","abi":1,"tools":{tools},"hooks":{hooks}}}"#);
    let decl_off = 64usize;
    let res_off = decl_off + decl.len();
    // Non-tool plugins return the decision directly; the tool plugin returns a
    // tool-result shape.
    wat(&format!(
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
    ))
}

fn wat(s: &str) -> Vec<u8> {
    // `wat` is a dev-dependency; available to examples.
    wat::parse_str(s).expect("wat")
}

fn main() -> anyhow::Result<()> {
    let mut reg = Registry::new(Runtime::new()?);

    // Leaf tool.
    reg.load("echo", &write("echo", plugin("echo", true, "", "", r#"{"kind":"success","content":"ran","value":{}}"#))?, serde_json::Value::Null)?;
    // Waterfall guard: veto any tool call.
    reg.load("guard", &write("guard", plugin("guard", false, "tools/pre-execute", "waterfall", r#"{"kind":"veto","reason":"policy"}"#))?, serde_json::Value::Null)?;
    // Waterfall redactor on pre-step: rewrite the input.
    reg.load("redact", &write("redact", plugin("redact", false, "agent/pre-step", "waterfall", r#"{"kind":"rewrite","value":{"turn":1,"input":"[REDACTED]"}}"#))?, serde_json::Value::Null)?;

    println!("hooks registered: {}", reg.hooks().len());
    let mut model = ScriptedModel::new(vec!["TOOL echo_tool {}".to_string()]);

    println!("\n--- turn 1 (guard active) ---");
    let out = run_turn(&mut reg, &mut model, 1, "secret text")?;
    println!("  vetoed: {:?}", out.vetoed);
    println!("  executed: {}", out.executed.len());

    println!("\n--- unloading guard ---");
    reg.unload("guard")?;

    let mut model = ScriptedModel::new(vec!["TOOL echo_tool {}".to_string()]);
    println!("\n--- turn 2 (guard gone) ---");
    let out = run_turn(&mut reg, &mut model, 2, "hello")?;
    println!("  vetoed: {:?}", out.vetoed);
    println!("  executed: {}", out.executed.len());
    println!("  hooks still registered: {}", reg.hooks().len());
    Ok(())
}

/// Write bytes to a temp file and return the path (Registry loads from paths).
fn write(name: &str, bytes: Vec<u8>) -> anyhow::Result<std::path::PathBuf> {
    let mut p = std::env::temp_dir();
    p.push(format!("intervene-{name}.wasm"));
    std::fs::write(&p, bytes)?;
    Ok(p)
}
