//! openhanako-shell — embeds the real openhanako renderer 1:1.
//!
//! The Studio window hosts an iframe pointed at the upstream UI
//! (`npm run dev:web` or a static preview). Backend stays whatever that
//! UI talks to (upstream open server / later our own).

use plugin_sdk as sdk;

#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    println!("openhanako-shell: embedding real openhanako UI");
    0
}

#[no_mangle]
pub extern "C" fn plugin_shutdown() {}

#[no_mangle]
pub extern "C" fn plugin_alloc(n: i32) -> i32 { sdk::alloc_block(n) }

#[no_mangle]
pub extern "C" fn plugin_free(p: i32, n: i32) {
    // SAFETY: host only frees pairs from plugin_alloc.
    unsafe { sdk::free_block(p, n) }
}

#[no_mangle]
pub extern "C" fn plugin_invoke(_: i32, _: i32, _: i32, _: i32, _: i32, _: i32) -> i64 { -2 }

const ENTRY: &str = include_str!("../js/entry.js");

#[no_mangle]
pub extern "C" fn plugin_describe(out: i32, cap: i32) -> i64 {
    let mut assets = serde_json::Map::new();
    assets.insert("entry.js".into(), ENTRY.into());
    let decl = serde_json::json!({
        "name": "openhanako-shell",
        "abi": 1,
        "tools": [],
        "ui": {
            "assets": assets,
            "windows": [{
                "name": "main",
                "component": "OpenhanakoShell",
                "title": "Hana",
                "width": 1440,
                "height": 900,
                "open": "startup"
            }]
        }
    })
    .to_string();
    unsafe { sdk::write_out(out, cap, decl.as_bytes()) }
}
