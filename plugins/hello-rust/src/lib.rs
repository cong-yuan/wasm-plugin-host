//! Example Rust WASM plugin implementing ABI v1.
//!
//! Build:  cargo build --release --target wasm32-wasip1
//! Output: target/wasm32-wasip1/release/hello_rust.wasm
//!
//! Config is read through [`plugin_sdk`], not by hand: the sizing convention
//! (`-(needed)` means "retry with more room") is easy to get wrong in a way that
//! is completely silent, so the retry lives in the SDK where it is tested.

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

/// Cached config, kept in a global so every op sees the latest value without
/// re-serializing. Refreshed by `plugin_configure` / `plugin_on_config`, and
/// lazily by `current_config()` when the version changed.
static mut CACHED: Option<(i64, serde_json::Value)> = None;

// ---------- ABI v1 exports ----------

/// Allocate `size` bytes and return a pointer. The host reads/writes here.
#[no_mangle]
pub extern "C" fn plugin_alloc(n: i32) -> i32 {
    sdk::alloc_block(n)
}

#[no_mangle]
pub extern "C" fn plugin_free(p: i32, n: i32) {
    // SAFETY: the host only ever frees a pair it previously got from
    // `plugin_alloc`, which is this plugin's only allocator.
    unsafe { sdk::free_block(p, n) }
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
/// Bad input is **reported**, never repaired. The op and the arguments are
/// decoded strictly: invalid UTF-8 is an error reply, and so is arguments JSON
/// that does not match what this tool declares. The alternative — substituting
/// defaults and returning `kind: "success"` — tells the model its call worked
/// while running something it did not ask for.
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

/// `greet`'s arguments, with **no** defaults: the tool's own declaration marks
/// `who` as `required`, so a missing or wrongly-typed `who` is a client error.
/// Accepting it and defaulting to `"world"` would contradict the schema the
/// model was given.
#[derive(Deserialize)]
struct GreetArgs {
    who: String,
}

fn refresh_config() {
    let v = sdk::config();
    let ver = sdk::config_version();
    unsafe {
        *std::ptr::addr_of_mut!(CACHED) = Some((ver, v));
    }
}

/// Return the cached config, refreshing it if the host's version changed.
unsafe fn current_config() -> serde_json::Value {
    let ver = sdk::config_version();
    let ptr = std::ptr::addr_of!(CACHED);
    match &*ptr {
        Some((cached_ver, v)) if *cached_ver == ver => v.clone(),
        _ => {
            let v = sdk::config();
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

fn invite_greet(args: &str) -> String {
    // No `unwrap_or(default)`: see `GreetArgs`.
    let parsed: GreetArgs = match serde_json::from_str(args) {
        Ok(p) => p,
        Err(e) => return sdk::error_json("BAD_ARGS", format!("greet expects `who` as a string: {e}")),
    };
    let now = unsafe { now_ms() };
    let template = unsafe { greet_template() };
    host_log(1, &format!("greet called for `{}`", parsed.who));
    json!({
        "kind": "success",
        "content": format!("{}, {}! (now_ms={})", template, parsed.who, now),
        "value": {
            "who": parsed.who,
            "template": template,
            "config_version": sdk::config_version()
        }
    })
    .to_string()
}

fn invoke_echo_num(args: &str) -> String {
    // `n` is declared as an integer, but **optional** (not in `required`), so a
    // missing `n` legitimately means 0. A *wrong type* does not: `"n": "x"`
    // must not silently become 0 and report success.
    let parsed: serde_json::Value = match serde_json::from_str(args) {
        Ok(v) => v,
        Err(e) => return sdk::error_json("BAD_ARGS", format!("echo_num expects JSON: {e}")),
    };
    let n = match parsed.get("n") {
        None | Some(serde_json::Value::Null) => 0,
        Some(v) => match v.as_i64() {
            Some(n) => n,
            None => {
                return sdk::error_json("BAD_ARGS", format!("echo_num expects `n` to be an integer, got {v}"))
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
/// Copy `src` into the guest buffer; `len` / `-needed`, per the ABI.
///
/// Delegated to the SDK: the boundary rule (in particular that `len == cap` is a
/// **success**, not a retry) has one implementation rather than one per plugin.
fn write_out(out: i32, cap: i32, src: &[u8]) -> i64 {
    // SAFETY: the host guarantees `cap` writable bytes at `out`, which is
    // exactly `sdk::write_out`'s precondition.
    unsafe { sdk::write_out(out, cap, src) }
}
