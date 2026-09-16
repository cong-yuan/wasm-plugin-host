//! Example Rust WASM plugin implementing ABI v1.
//!
//! Build:  cargo build --release --target wasm32-wasip1
//! Output: target/wasm32-wasip1/release/hello_rust.wasm

use serde::Deserialize;
use serde_json::json;

// ---------- host imports (provided by the host's linker) ----------

#[link(wasm_import_module = "host")]
extern "C" {
    fn log(level: i32, ptr: *const u8, len: usize);
    fn now_ms() -> i64;
}

fn host_log(level: i32, msg: &str) {
    unsafe { log(level, msg.as_ptr(), msg.len()) }
}

// ---------- ABI v1 exports ----------

/// Allocate `size` bytes and return a pointer. The host reads/writes here.
#[no_mangle]
pub extern "C" fn plugin_alloc(size: i32) -> i32 {
    let mut v = Vec::<u8>::with_capacity(size.max(0) as usize);
    let ptr = v.as_mut_ptr() as i32;
    std::mem::forget(v); // host owns it until plugin_free
    ptr
}

#[no_mangle]
pub extern "C" fn plugin_free(ptr: i32, size: i32) {
    unsafe {
        let _ = Vec::from_raw_parts(ptr as *mut u8, 0, size.max(0) as usize);
    }
}

#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 {
    1
}

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    host_log(1, "hello-rust: init");
    0
}

#[no_mangle]
pub extern "C" fn plugin_shutdown() {
    host_log(1, "hello-rust: shutdown");
}

/// Write the declaration JSON into `out`; return len, or -needed if cap too small.
#[no_mangle]
pub extern "C" fn plugin_describe(out: i32, cap: i32) -> i64 {
    let decl = json!({
        "name": "hello-rust",
        "abi": 1,
        "tools": [
            {
                "name": "greet",
                "description": "Return a greeting for `who`",
                "parameters": {
                    "type": "object",
                    "properties": { "who": { "type": "string" } },
                    "required": ["who"]
                },
                "exec": "greet"
            },
            {
                "name": "echo_num",
                "description": "Return the number plus one",
                "parameters": {
                    "type": "object",
                    "properties": { "n": { "type": "integer" } }
                },
                "exec": "echo_num"
            }
        ]
    });
    write_out(out, cap, decl.to_string().as_bytes())
}

/// Run `op`; args/result are UTF-8 JSON.
#[no_mangle]
pub extern "C" fn plugin_invoke(
    op_ptr: i32,
    op_len: i32,
    args_ptr: i32,
    args_len: i32,
    out: i32,
    cap: i32,
) -> i64 {
    let op = unsafe { read_str(op_ptr, op_len) };
    let args = unsafe { read_str(args_ptr, args_len) };

    let result = match op.as_str() {
        "greet" => invite_greet(&args),
        "echo_num" => invoke_echo_num(&args),
        other => json!({ "kind": "error", "message": format!("unknown op {other}"), "code": "NO_OP" }),
    };
    write_out(out, cap, result.to_string().as_bytes())
}

// ---------- helpers ----------

#[derive(Deserialize)]
struct GreetArgs {
    #[serde(default = "default_who")]
    who: String,
}
fn default_who() -> String {
    "world".to_string()
}

fn invite_greet(args: &str) -> serde_json::Value {
    let parsed: GreetArgs = serde_json::from_str(args).unwrap_or(GreetArgs { who: default_who() });
    let now = unsafe { now_ms() };
    host_log(1, &format!("greet called for `{}`", parsed.who));
    json!({
        "kind": "success",
        "content": format!("Hello, {} (v2)! (host now_ms={})", parsed.who, now),
        "value": { "who": parsed.who }
    })
}

fn invoke_echo_num(args: &str) -> serde_json::Value {
    let parsed: serde_json::Value = serde_json::from_str(args).unwrap_or(json!({}));
    let n = parsed.get("n").and_then(|v| v.as_i64()).unwrap_or(0);
    json!({
        "kind": "success",
        "content": format!("{}", n + 1),
        "value": { "n": n, "n_plus_one": n + 1 }
    })
}

unsafe fn read_str(ptr: i32, len: i32) -> String {
    if ptr == 0 || len <= 0 {
        return String::new();
    }
    let bytes = std::slice::from_raw_parts(ptr as *const u8, len as usize);
    String::from_utf8_lossy(bytes).into_owned()
}

/// Copy `src` into `(out, cap)`; return len, or -needed.
fn write_out(out: i32, cap: i32, src: &[u8]) -> i64 {
    if out == 0 {
        return -(src.len() as i64);
    }
    let cap = cap.max(0) as usize;
    if src.len() > cap {
        return -(src.len() as i64);
    }
    unsafe {
        std::ptr::copy_nonoverlapping(src.as_ptr(), out as *mut u8, src.len());
    }
    src.len() as i64
}
