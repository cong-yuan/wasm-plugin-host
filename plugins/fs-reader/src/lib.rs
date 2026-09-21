//! Demonstrates that a **trusted** plugin has real filesystem access.
//!
//! It reads the path from its config (`{"path": "/some/file"}`) via
//! `host.get_config` and logs the contents. This only works because the host
//! preopens `/` — see `docs/已知问题.md` for the capability decision.
//!
//! Config goes through [`plugin_sdk`] rather than a hand-rolled `get_config`:
//! this file used to read into a fixed 4 KiB buffer and treat `-(needed)` as
//! "no config", so any config over 4 KiB silently read as unconfigured.

use plugin_sdk as sdk;

/// Pull the config JSON the host injected, and read `path` out of it.
fn configured_path() -> Option<String> {
    let v = sdk::config();
    v.get("path").and_then(|p| p.as_str()).map(str::to_string)
}

#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 {
    1
}

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    let Some(path) = configured_path() else {
        println!("FS_ERR no `path` in config");
        return 0;
    };
    match std::fs::read_to_string(&path) {
        Ok(s) => println!("FS_READ_OK content={}", s.trim()),
        Err(e) => println!("FS_READ_ERR {e}"),
    }
    0
}

#[no_mangle]
pub extern "C" fn plugin_shutdown() {}

#[no_mangle]
pub extern "C" fn plugin_alloc(n: i32) -> i32 {
    let mut v = Vec::<u8>::with_capacity(n.max(0) as usize);
    let p = v.as_mut_ptr() as i32;
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn plugin_free(_p: i32, _n: i32) {}

#[no_mangle]
pub extern "C" fn plugin_describe(out: i32, cap: i32) -> i64 {
    let d = br#"{"name":"fs-reader","abi":1,"tools":[]}"#;
    if out == 0 || d.len() > cap.max(0) as usize {
        return -(d.len() as i64);
    }
    unsafe { std::ptr::copy_nonoverlapping(d.as_ptr(), out as *mut u8, d.len()) };
    d.len() as i64
}

#[no_mangle]
pub extern "C" fn plugin_invoke(_a: i32, _b: i32, _c: i32, _d: i32, _e: i32, _f: i32) -> i64 {
    -2
}
