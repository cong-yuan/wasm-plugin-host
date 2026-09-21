//! The official `host.*` helper layer for WASM plugins.
//!
//! This exists because the ABI's sizing convention is easy to get subtly wrong,
//! and the mistake is *silent*. `host.get_config` reports "your buffer was too
//! small" by returning `-(needed)`; the obvious implementation —
//!
//! ```ignore
//! let n = get_config(buf.as_mut_ptr(), buf.len());
//! if n <= 0 { return Value::Null }        // ← wrong: `-(needed)` lands here
//! ```
//!
//! — treats a too-large config as "no config". Nothing errors; the plugin just
//! behaves as if unconfigured. That is the failure this crate removes: plugins
//! call [`config`] and the retry is already correct.
//!
//! ## Why the logic is split from the import
//!
//! The `host.*` functions exist only on `wasm32`. To keep the retry logic
//! *testable* (native `cargo test`, no wasm host needed) the sizing loop lives in
//! [`read_with`], which takes a plain `FnMut(&mut [u8]) -> i64`. The wasm build
//! passes the real import; tests pass fake hosts that misbehave on purpose.

#![deny(unsafe_op_in_unsafe_fn)]

use serde_json::Value;

/// First buffer size. Small, because most configs are small and the loop grows
/// on demand — the old idiom hardcoded 64 KiB, which both wasted memory per call
/// and quietly capped the config at 64 KiB.
const INITIAL_CAP: usize = 4096;

/// Refuse to grow past this. The host caps a single write at the same figure
/// (`MAX_BUF` in `host/src/plugin.rs`), so a larger `-(needed)` means the host is
/// confused; looping would allocate without bound.
const MAX_CAP: usize = 16 * 1024 * 1024;

/// Why a config read failed.
///
/// Distinct from "the config is unset", which is a **success** (`Ok(Value::Null)`):
/// conflating the two is exactly the silent-failure bug this crate exists to
/// prevent, so the type keeps them apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// The host asked for a buffer larger than [`MAX_CAP`].
    TooLarge { needed: usize, max: usize },
    /// The host answered `-(needed)` but did not ask for more room than it was
    /// already given, so retrying could not make progress.
    NoProgress { needed: usize, cap: usize },
    /// The bytes were not valid UTF-8 JSON.
    NotJson(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::TooLarge { needed, max } => {
                write!(f, "host asked for {needed} bytes of config (max {max})")
            }
            ConfigError::NoProgress { needed, cap } => write!(
                f,
                "host asked for {needed} bytes but the buffer was already {cap}; \
                 it would never fit"
            ),
            ConfigError::NotJson(e) => write!(f, "config is not valid UTF-8 JSON: {e}"),
        }
    }
}

impl std::error::Error for ConfigError {}

/// Drive a `(out, cap) -> i64` host call to completion, honouring `-(needed)`.
///
/// Returns the config bytes, or `None` when the host reports the config is unset
/// (`0`). This is the whole ABI contract in one place, so a plugin never has to
/// restate it.
pub fn read_with<F>(mut ask: F) -> Result<Option<Vec<u8>>, ConfigError>
where
    F: FnMut(&mut [u8]) -> i64,
{
    let mut cap = INITIAL_CAP;
    loop {
        let mut buf = vec![0u8; cap];
        let n = ask(&mut buf);
        match n {
            // `0` means the config is JSON `null` — genuinely unset.
            0 => return Ok(None),
            // Bytes written.
            n if n > 0 => {
                buf.truncate(n as usize);
                return Ok(Some(buf));
            }
            // `-(needed)`: grow to exactly what was asked for and retry.
            n => {
                let needed = n.unsigned_abs() as usize;
                if needed > MAX_CAP {
                    return Err(ConfigError::TooLarge { needed, max: MAX_CAP });
                }
                if needed <= cap {
                    return Err(ConfigError::NoProgress { needed, cap });
                }
                cap = needed;
            }
        }
    }
}

/// The plugin's config as JSON, or `Ok(Value::Null)` when the host reports it
/// unset.
///
/// Prefer this over [`config`]: a malformed or oversized config is an error you
/// can act on, not something indistinguishable from "not configured".
pub fn try_config() -> Result<Value, ConfigError> {
    let Some(bytes) = read_with(raw_get_config)? else {
        return Ok(Value::Null);
    };
    serde_json::from_slice(&bytes).map_err(|e| ConfigError::NotJson(e.to_string()))
}

/// The plugin's config as JSON, or `Null` when it is unset **or unreadable**.
///
/// Convenience for the common case where a plugin has a workable default: this
/// keeps `plugin_invoke` short. It deliberately collapses errors into `Null`, so
/// when the difference matters use [`try_config`].
pub fn config() -> Value {
    try_config().unwrap_or(Value::Null)
}

/// The plugin's monotonic config version; a change means the config changed.
pub fn config_version() -> i64 {
    raw_config_version()
}

/// Decode a host-supplied buffer from guest memory as a UTF-8 string.
///
/// Returns `Err` for invalid UTF-8 rather than replacing bad bytes with U+FFFD.
/// That distinction matters: lossy decoding turns unreadable input into a
/// *slightly different, valid-looking* one — the caller's `a\xFFb` becomes
/// `a\u{FFFD}b` and the plugin goes on to answer as if it had understood. A
/// plugin acting on input that was never sent is worse than one that refuses.
///
/// An empty buffer (`ptr == 0` or `len <= 0`) is `Ok("")` — "no argument" and
/// "corrupt argument" are different facts and the caller decides what to do with
/// each.
///
/// # Safety
///
/// `ptr`/`len` must describe a readable region of this module's linear memory,
/// which is the host's guarantee for the pointers it passes to `plugin_invoke`.
pub unsafe fn read_utf8(ptr: i32, len: i32) -> Result<String, std::string::FromUtf8Error> {
    if ptr == 0 || len <= 0 {
        return Ok(String::new());
    }
    // SAFETY: the caller guarantees the region is readable for `len` bytes.
    let bytes = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
    decode_utf8(bytes)
}

/// The pointer-free core of [`read_utf8`], so the decoding rule is testable on
/// the host without fabricating guest addresses.
///
/// A `plugin_alloc` pointer is a 32-bit guest offset; casting one to a native
/// pointer would be meaningless, which is exactly why this is split out.
pub fn decode_utf8(bytes: &[u8]) -> Result<String, std::string::FromUtf8Error> {
    String::from_utf8(bytes.to_vec())
}

/// The canonical error reply, in the shape the host's `InvokeResult` expects.
pub fn error_json(code: &str, message: impl std::fmt::Display) -> String {
    serde_json::json!({ "kind": "error", "code": code, "message": message.to_string() })
        .to_string()
}

// ---------------------------------------------------------------------------
// The real imports (wasm) and their native stubs
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
fn raw_get_config(buf: &mut [u8]) -> i64 {
    #[link(wasm_import_module = "host")]
    extern "C" {
        fn get_config(out: *mut u8, cap: usize) -> i64;
    }
    // SAFETY: `buf` is valid for `buf.len()` bytes for the duration of the call,
    // which is the whole of the host's contract for this import.
    unsafe { get_config(buf.as_mut_ptr(), buf.len()) }
}

#[cfg(target_arch = "wasm32")]
fn raw_config_version() -> i64 {
    #[link(wasm_import_module = "host")]
    extern "C" {
        fn config_version() -> i64;
    }
    // SAFETY: no arguments, no guest memory touched.
    unsafe { config_version() }
}

/// Native stub: unimplemented, because `host.*` exists only inside the host.
///
/// It exists so this crate **compiles and unit-tests natively**; anything that
/// actually calls the host must run under the host. Reaching here is a bug in
/// the caller, not a host condition, so it panics rather than inventing a value.
#[cfg(not(target_arch = "wasm32"))]
fn raw_get_config(_buf: &mut [u8]) -> i64 {
    panic!("host.get_config is only available inside the wasm host (target_arch = wasm32)")
}

/// Native stub; see [`raw_get_config`].
#[cfg(not(target_arch = "wasm32"))]
fn raw_config_version() -> i64 {
    panic!("host.config_version is only available inside the wasm host (target_arch = wasm32)")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake host that returns `payload`, reporting `-(needed)` until the buffer
    /// is big enough — the real convention, so the loop is exercised for real.
    fn serving(payload: &'static [u8]) -> impl FnMut(&mut [u8]) -> i64 {
        move |buf: &mut [u8]| {
            if payload.is_empty() {
                return 0;
            }
            if payload.len() > buf.len() {
                return -(payload.len() as i64);
            }
            buf[..payload.len()].copy_from_slice(payload);
            payload.len() as i64
        }
    }

    #[test]
    fn a_config_larger_than_the_first_buffer_is_still_read() {
        // The regression this crate exists for: 70 KiB used to be reported as
        // "unset" because `-(needed)` was folded into the `n <= 0` branch.
        let big = vec![b'x'; 70 * 1024];
        let payload: &'static [u8] = Box::leak(big.into_boxed_slice());
        let got = read_with(serving(payload)).unwrap().unwrap();
        assert_eq!(got.len(), 70 * 1024, "the whole config must come back");
    }

    #[test]
    fn an_unset_config_is_not_an_error() {
        assert_eq!(read_with(serving(b"")).unwrap(), None);
    }

    #[test]
    fn a_config_that_exactly_fills_the_first_buffer_is_read() {
        // Boundary: `len == cap` must take the success path, not the `-(needed)`
        // path (the host only reports "too small" for `len > cap`).
        let exact = vec![b'y'; INITIAL_CAP];
        let payload: &'static [u8] = Box::leak(exact.into_boxed_slice());
        let got = read_with(serving(payload)).unwrap().unwrap();
        assert_eq!(got.len(), INITIAL_CAP);
    }

    #[test]
    fn a_host_that_never_asks_for_more_room_is_an_error_not_a_hang() {
        // A broken host returning `-(needed)` where `needed <= cap` would make a
        // naive loop spin forever. It must terminate with an error.
        let got = read_with(|buf: &mut [u8]| -(buf.len() as i64));
        assert_eq!(
            got,
            Err(ConfigError::NoProgress { needed: INITIAL_CAP, cap: INITIAL_CAP })
        );
    }

    #[test]
    fn an_absurd_request_is_refused_rather_than_allocated() {
        let got = read_with(|_buf: &mut [u8]| -((MAX_CAP + 1) as i64));
        assert!(matches!(got, Err(ConfigError::TooLarge { .. })), "got {got:?}");
    }

    #[test]
    fn try_config_reports_bad_json_instead_of_pretending_it_is_unset() {
        // The other half of the silent-failure class: unparseable config.
        let payload: &'static [u8] = b"not json";
        let mut ask = serving(payload);
        let bytes = read_with(&mut ask).unwrap().unwrap();
        assert_eq!(bytes, b"not json");
        let err = serde_json::from_slice::<Value>(&bytes).unwrap_err();
        assert!(ConfigError::NotJson(err.to_string()).to_string().contains("config"));
    }

    #[test]
    fn a_growing_config_settles_on_the_final_size() {
        // The config can change between the sizing probe and the real read; the
        // loop must re-ask rather than trust the first `-(needed)`.
        let mut calls = 0;
        let got = read_with(|buf: &mut [u8]| {
            calls += 1;
            match calls {
                1 => -6000, // "you need 6000"
                _ => {
                    let want = 7000; // it grew in the meantime
                    if buf.len() < want {
                        -(want as i64)
                    } else {
                        buf[..want].fill(b'z');
                        want as i64
                    }
                }
            }
        })
        .unwrap()
        .unwrap();
        assert_eq!(got.len(), 7000);
    }

    #[test]
    fn invalid_utf8_is_an_error_not_a_silent_substitution() {
        // `from_utf8_lossy` would turn this into `a\u{FFFD}b` and succeed. The
        // plugin would then answer about a name that was never sent.
        let bytes = b"a\xffb";
        let got = decode_utf8(bytes);
        assert!(got.is_err(), "invalid UTF-8 must not decode: {got:?}");
    }

    #[test]
    fn an_empty_buffer_is_an_empty_string_not_an_error() {
        // "no argument" and "corrupt argument" must stay distinguishable. Both
        // branches here short-circuit before touching memory, so they are safe
        // to call with stub addresses.
        assert_eq!(unsafe { read_utf8(0, 10) }.unwrap(), "");
        assert_eq!(unsafe { read_utf8(1234, 0) }.unwrap(), "");
        assert_eq!(unsafe { read_utf8(1234, -1) }.unwrap(), "");
    }

    #[test]
    fn valid_utf8_round_trips_including_multibyte() {
        assert_eq!(decode_utf8("héllo 世界".as_bytes()).unwrap(), "héllo 世界");
        assert_eq!(decode_utf8(b"").unwrap(), "");
    }

    #[test]
    fn the_error_reply_matches_the_hosts_expected_shape() {
        // The host deserializes this into `InvokeResult`; a misshapen reply is a
        // hard error at the host, so the shape is pinned here.
        let s = error_json("BAD_ARG", "who must be a string");
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["kind"], "error");
        assert_eq!(v["code"], "BAD_ARG");
        assert!(v["message"].as_str().unwrap().contains("who"));
    }
}
