//! A *second* version of `hello-rust`, used as the hot-reload fixture: the two
//! differ only in their greeting, so a reload is observable from a tool call.
//!
//! Build:  cargo build --release --target wasm32-wasip1
//! Output: target/wasm32-wasip1/release/hello_rust_v2.wasm

use plugin_sdk as sdk;
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
///
/// Malformed input is reported, not repaired — see the same change in
/// `plugins/hello-rust`, which this file mirrors. A plugin that substitutes
/// defaults and answers `kind: "success"` tells the model its call worked while
/// running something it never asked for.
#[no_mangle]
pub extern "C" fn plugin_invoke(
    op_ptr: i32,
    op_len: i32,
    args_ptr: i32,
    args_len: i32,
    out: i32,
    cap: i32,
) -> i64 {
    // SAFETY: the host passes a readable region for each (ptr, len) pair.
    let (op, args) = unsafe {
        match (sdk::read_utf8(op_ptr, op_len), sdk::read_utf8(args_ptr, args_len)) {
            (Ok(op), Ok(args)) => (op, args),
            (Err(e), _) => return write_out(out, cap, sdk::error_json("BAD_OP", e).as_bytes()),
            (_, Err(e)) => {
                return write_out(out, cap, sdk::error_json("BAD_ARGS_UTF8", e).as_bytes())
            }
        }
    };

    let result = match op.as_str() {
        "greet" => invite_greet(&args),
        "echo_num" => invoke_echo_num(&args),
        other => sdk::error_json("NO_OP", format!("unknown op `{other}`")),
    };
    write_out(out, cap, result.as_bytes())
}

// ---------- helpers ----------

/// No default for `who`: the declaration marks it `required`.
#[derive(Deserialize)]
struct GreetArgs {
    who: String,
}

fn invite_greet(args: &str) -> String {
    let parsed: GreetArgs = match serde_json::from_str(args) {
        Ok(p) => p,
        Err(e) => {
            return sdk::error_json("BAD_ARGS", format!("greet expects `who` as a string: {e}"))
        }
    };
    let now = unsafe { now_ms() };
    host_log(1, &format!("greet called for `{}`", parsed.who));
    json!({
        "kind": "success",
        "content": format!("Hello, {} (v2)! (host now_ms={})", parsed.who, now),
        "value": { "who": parsed.who }
    })
    .to_string()
}

fn invoke_echo_num(args: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(args) {
        Ok(v) => v,
        Err(e) => return sdk::error_json("BAD_ARGS", format!("echo_num expects JSON: {e}")),
    };
    // `n` is optional but must be an integer when present.
    let n = match parsed.get("n") {
        None | Some(serde_json::Value::Null) => 0,
        Some(v) => match v.as_i64() {
            Some(n) => n,
            None => {
                return sdk::error_json(
                    "BAD_ARGS",
                    format!("echo_num expects `n` to be an integer, got {v}"),
                )
            }
        },
    };
    json!({
        "kind": "success",
        "content": format!("{}", n + 1),
        "value": { "n": n, "n_plus_one": n + 1 }
    })
    .to_string()
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
