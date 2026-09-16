//! Regression: WASI guest calls must not run on a tokio async worker thread.
//!
//! `wasmtime-wasi` 44 implements every WASI p1 call through `runtime::in_tokio`,
//! which does `Handle::current().block_on(..)`. Calling that from *inside* an
//! async context nests `block_on` and panics with
//! "Cannot start a runtime from within a runtime".
//!
//! This matters to any embedder that drives the registry from async code (the
//! Tauri studio mounts plugins from `#[tauri::command] async fn`s). The fix is
//! to run guest calls on the blocking pool, which `inside_runtime_*` pins.
//!
//! Tests:
//! - `load_outside_runtime`          — the plain synchronous path
//! - `load_inside_runtime_blocks`    — the crash, if called directly (ignored)
//! - `load_inside_runtime_spawn_blocking` — the supported pattern

#![allow(dead_code)]
use wasm_plugin_host::{Registry, Runtime};

fn plugin_with_wasi_call() -> Vec<u8> {
    let decl = r#"{"name":"p","abi":1,"tools":[]}"#;
    let wat = format!(
        r#"(module
          (import "wasi_snapshot_preview1" "fd_write"
            (func $fd_write (param i32 i32 i32 i32) (result i32)))
          (memory (export "memory") 2)
          (global $bump (mut i32) (i32.const 8192))
          (data (i32.const 100) "hi")
          (data (i32.const 300) {decl:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32)
            (i32.store (i32.const 400) (i32.const 100))
            (i32.store (i32.const 404) (i32.const 2))
            (drop (call $fd_write (i32.const 1) (i32.const 400) (i32.const 1) (i32.const 408)))
            (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32) (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n))) (local.get $p))
          (func (export "plugin_free") (param i32 i32))
          (func (export "plugin_describe") (param $o i32) (param $c i32) (result i64)
            (local $i i32) (local.set $i (i32.const 0))
            (block $d (loop $l
              (br_if $d (i32.ge_s (local.get $i) (i32.const {dlen})))
              (i32.store8 (i32.add (local.get $o) (local.get $i))
                (i32.load8_u (i32.add (i32.const 300) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
            (i64.const {dlen}))
          (func (export "plugin_invoke")
            (param i32 i32 i32 i32) (param i32 i32) (result i64) (i64.const 0))
        )"#,
        decl = decl,
        dlen = decl.len(),
    );
    wat::parse_str(&wat).unwrap()
}

#[test]
fn load_outside_runtime() {
    let dir = std::env::temp_dir().join("wasi-rt-sync");
    let _ = std::fs::create_dir_all(&dir);
    let p = dir.join("p.wasm");
    std::fs::write(&p, plugin_with_wasi_call()).unwrap();
    let mut reg = Registry::new(Runtime::new().unwrap());
    reg.load("s", &p, serde_json::Value::Null).expect("SYNC-OK");
    println!("SYNC-OK");
}

#[test]
fn load_inside_runtime_spawn_blocking() {
    let dir = std::env::temp_dir().join("wasi-rt-async");
    let _ = std::fs::create_dir_all(&dir);
    let p = dir.join("p.wasm");
    std::fs::write(&p, plugin_with_wasi_call()).unwrap();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(async {
        // 方案 A：把 guest 调用挪到 blocking pool（不在 async 执行上下文里）
        let path = p.clone();
        tokio::task::spawn_blocking(move || {
            let mut reg = Registry::new(Runtime::new().unwrap());
            reg.load("s", &path, serde_json::Value::Null).expect("SPAWN_BLOCKING-OK");
            println!("SPAWN_BLOCKING-OK");
        })
        .await
        .unwrap();
    });
}

/// Calling a guest WASI function **directly** on a tokio worker panics. Marked
/// `#[ignore]` because the panic aborts the test process; run it explicitly with
/// `cargo test -- --ignored` to see the failure the embedder must avoid.
#[test]
#[ignore = "panics by design; run with --ignored to observe the hazard"]
fn load_inside_runtime_directly_panics() {
    let dir = std::env::temp_dir().join("wasi-rt-direct");
    let _ = std::fs::create_dir_all(&dir);
    let p = dir.join("p.wasm");
    std::fs::write(&p, plugin_with_wasi_call()).unwrap();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let mut reg = Registry::new(Runtime::new().unwrap());
        // This is the bug: a guest WASI call from async context nests block_on.
        reg.load("s", &p, serde_json::Value::Null).unwrap();
    });
}
