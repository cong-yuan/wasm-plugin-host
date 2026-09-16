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
    /// Write the current config JSON into `out` (capacity `cap`).
    /// Returns bytes written, `-(needed)` if too small, or 0 if config is null.
    fn get_config(out: *mut u8, cap: usize) -> i64;
    /// Monotonic config version; bump means the config changed.
    fn config_version() -> i64;
}

fn host_log(level: i32, msg: &str) {
    unsafe { log(level, msg.as_ptr(), msg.len()) }
}

/// Pull the plugin's current config as a `serde_json::Value` (Null if unset).
fn read_host_config() -> serde_json::Value {
    let mut buf = vec![0u8; 64 * 1024];
    let n = unsafe { get_config(buf.as_mut_ptr(), buf.len()) };
    if n <= 0 {
        return serde_json::Value::Null;
    }
    serde_json::from_slice(&buf[..n as usize]).unwrap_or(serde_json::Value::Null)
}

/// Cached config, kept in a global so every op sees the latest value without
/// re-serializing. Refreshed by `plugin_configure` / `plugin_on_config`, and
/// lazily by `current_config()` when the version changed.
static mut CACHED: Option<(i64, serde_json::Value)> = None;

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

fn refresh_config() {
    let v = read_host_config();
    let ver = unsafe { config_version() };
    unsafe {
        *std::ptr::addr_of_mut!(CACHED) = Some((ver, v));
    }
}

/// Return the cached config, refreshing it if the host's version changed.
unsafe fn current_config() -> serde_json::Value {
    let ver = config_version();
    let ptr = std::ptr::addr_of!(CACHED);
    match &*ptr {
        Some((cached_ver, v)) if *cached_ver == ver => v.clone(),
        _ => {
            let v = read_host_config();
            *std::ptr::addr_of_mut!(CACHED) = Some((ver, v.clone()));
            v
        }
    }
}

/// The greeting template from config, defaulting sensibly.
unsafe fn greet_template() -> String {
    current_config()
        .get("greeting")
        .and_then(|v| v.as_str())
        .unwrap_or("Hello")
        .to_string()
}

fn invite_greet(args: &str) -> serde_json::Value {
    let parsed: GreetArgs = serde_json::from_str(args).unwrap_or(GreetArgs { who: default_who() });
    let now = unsafe { now_ms() };
    let template = unsafe { greet_template() };
    host_log(1, &format!("greet called for `{}`", parsed.who));
    json!({
        "kind": "success",
        "content": format!("{}, {}! (now_ms={})", template, parsed.who, now),
        "value": {
            "who": parsed.who,
            "template": template,
            "config_version": unsafe { config_version() }
        }
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

/// Called once by the host at load, after `plugin_init`. Read our config now
/// so `greet` can use it. Return 0 on success.
#[no_mangle]
pub extern "C" fn plugin_configure(_out: i32, _cap: i32) -> i32 {
    refresh_config();
    let v = unsafe { current_config() };
    host_log(1, &format!("hello-rust: configured with {v}"));
    0
}

/// Called by the host when the config is pushed live (no restart). Re-read it
/// and report the change. Return 0 on success.
#[no_mangle]
pub extern "C" fn plugin_on_config() -> i32 {
    // The host has already swapped the value in shared state; grab it fresh.
    refresh_config();
    let now = unsafe { current_config() };
    host_log(1, &format!("hello-rust: on_config -> {now}"));
    0
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
