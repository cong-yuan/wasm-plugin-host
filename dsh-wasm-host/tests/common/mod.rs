//! Shared test fixtures: hermetic WAT plugins and a dsh harness boot.
//!
//! Plugins are tiny WAT modules compiled in-process, so the suite needs no
//! `cargo build` of a wasm plugin and no network.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use cordis::Context;
use dsh_wasm_host::WasmHost;

/// Build a minimal ABI-v1 module declaring one tool `<slot>_tool`.
///
/// `action` selects what `plugin_invoke` returns:
/// * `success` — `{"kind":"success","content":"…","value":{…}}`
/// * any other string is emitted verbatim (for hook decisions).
pub fn wasm_tool(slot: &str, action: &str) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{slot}_tool","description":"tool {slot}","exec":"go"}}]}}"#
    );
    let reply = if action == "success" {
        format!(
            r#"{{"kind":"success","content":"{slot} ran","value":{{"slot":"{slot}","n":1}}}}"#
        )
    } else {
        action.to_string()
    };
    build(&decl, &reply)
}

/// Same as [`wasm_tool`] but with a configurable declared tool name, so a
/// reload can change the tool surface (hot-swap test).
pub fn wasm_tool_named(slot: &str, tool: &str) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{tool}","description":"tool {tool}","exec":"go"}}]}}"#
    );
    let reply = format!(r#"{{"kind":"success","content":"{tool} ran","value":{{}}}}"#);
    build(&decl, &reply)
}

/// A plugin declaring **no tools** but one hook on `event`, with `mode` and a
/// fixed `decision` reply. Used to exercise the flow bridge.
pub fn wasm_hook(slot: &str, event: &str, mode: &str, decision: &str) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[],"hooks":[{{"on":"{event}","exec":"check","mode":"{mode}"}}]}}"#
    );
    build(&decl, decision)
}

/// A plugin with both a tool and a `tools/pre-execute` waterfall hook that
/// vetoes — lets tests observe a guest blocking a tool call.
pub fn wasm_tool_with_veto(slot: &str, tool: &str) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{tool}","description":"guarded","exec":"go"}}],"hooks":[{{"on":"tools/pre-execute","exec":"check","mode":"waterfall"}}]}}"#
    );
    build(&decl, r#"{"kind":"veto","reason":"blocked by guest"}"#)
}

/// A **provider** plugin: declares `provides: [services…]` and answers any
/// service call with a fixed JSON reply. Lets tests check that a WASM slot's
/// `provides` becomes a real cordis service.
pub fn wasm_provider(slot: &str, services: &[&str]) -> Vec<u8> {
    let provides = services
        .iter()
        .map(|s| format!("\"{s}\""))
        .collect::<Vec<_>>()
        .join(",");
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[],"provides":[{provides}]}}"#
    );
    // Any op returns the same payload, tagged with the slot name.
    let reply = format!(r#"{{"kind":"success","content":"served by {slot}","value":{{"provider":"{slot}"}}}}"#);
    build(&decl, &reply)
}

/// An **injector** plugin: declares `injects: [services…]` and no tools. It is
/// only active once those services exist; gives tests a dependency to gate on.
pub fn wasm_injector(slot: &str, services: &[&str]) -> Vec<u8> {
    let injects = services
        .iter()
        .map(|s| format!("\"{s}\""))
        .collect::<Vec<_>>()
        .join(",");
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{slot}_tool","description":"injector tool","exec":"go"}}],"injects":[{injects}]}}"#
    );
    build(&decl, r#"{"kind":"success","content":"ok","value":{}}"#)
}

/// Compile the common module skeleton around a declaration + invoke reply.
fn build(decl: &str, reply: &str) -> Vec<u8> {
    let decl_off = 64usize;
    let res_off = decl_off + decl.len();
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (import "host" "now_ms" (func $now (result i64)))
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 8192))
          (data (i32.const {decl_off}) {decl:?})
          (data (i32.const {res_off}) {reply:?})
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
            (call $blit (i32.const {decl_off}) (i32.const {dlen}) (local.get $out) (local.get $cap)))
          (func (export "plugin_invoke")
            (param $op i32) (param $oplen i32) (param $a i32) (param $alen i32)
            (param $out i32) (param $cap i32) (result i64)
            (call $blit (i32.const {res_off}) (i32.const {rlen}) (local.get $out) (local.get $cap)))
        )"#,
        decl_off = decl_off,
        res_off = res_off,
        decl = decl,
        reply = reply,
        dlen = decl.len(),
        rlen = reply.len(),
    );
    wat::parse_str(&wat).expect("test wat should parse")
}

/// A unique, freshly-created temp dir per call site.
pub fn tmpdir(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("dwh-{}-{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

/// Write `bytes` to `dir/name.wasm` and return the path.
pub fn write_wasm(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(format!("{name}.wasm"));
    std::fs::write(&path, bytes).unwrap();
    path
}

/// Build a host with a cordis-logger-backed log hook (exercises that path).
pub fn host() -> WasmHost {
    WasmHost::new().expect("host builds")
}

/// Boot dsh's base bundle on a fresh context.
pub async fn boot_dsh(ctx: &Context) {
    dsh_rs::bundle::install_base_default(ctx)
        .await
        .expect("dsh base bundle boots");
}

/// Swap in a mock adapter that echoes the last user message.
pub async fn script_echo(ctx: &Context) {
    use dsh_rs::api::services::{LlmService, LlmAdapterApi};
    let runtime = ctx
        .require::<LlmService>(dsh_rs::api::LLM_SERVICE)
        .expect("llm service live");
    runtime.unregister_adapter(&["mock"]);
    let adapter: std::sync::Arc<dyn LlmAdapterApi> =
        std::sync::Arc::new(dsh_rs::llm::adapters::mock::MockAdapter::new());
    runtime.register_adapter(&["mock"], adapter).unwrap();
}

/// Script the mock adapter to call one tool, then finish.
pub async fn script_tool_call(
    ctx: &Context,
    id: &str,
    tool: &str,
    args: serde_json::Value,
) {
    use dsh_rs::api::services::{LlmAdapterApi, LlmService};
    let runtime = ctx
        .require::<LlmService>(dsh_rs::api::LLM_SERVICE)
        .expect("llm service live");
    runtime.unregister_adapter(&["mock"]);
    let adapter: std::sync::Arc<dyn LlmAdapterApi> =
        std::sync::Arc::new(dsh_rs::llm::adapters::mock::MockAdapter::scripted(vec![
            dsh_rs::llm::adapters::mock::MockAdapter::tool_call_response(id, tool, args),
            dsh_rs::llm::adapters::mock::MockAdapter::text_response("finished"),
        ]));
    runtime.register_adapter(&["mock"], adapter).unwrap();
}
