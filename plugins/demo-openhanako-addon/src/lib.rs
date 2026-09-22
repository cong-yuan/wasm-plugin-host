//! `demo-openhanako-addon` — extends `openhanako-shell` via its public slots.
//!
//! Knows nothing about the iframe or overlay layout — only `openhanako.*`
//! slot names. If the shell is rewritten, this keeps working as long as those
//! names hold.

use plugin_sdk as sdk;

#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    println!("demo-openhanako-addon: up (extends openhanako-shell through slots)");
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

const INJECTS: &[(&str, &str)] = &[
    ("openhanako.titlebar.right", "OhkAddonHeaderButton"),
    ("openhanako.sidebar.notice", "OhkAddonNotice"),
    ("openhanako.conversation.input.dock", "OhkAddonComposerChip"),
    ("openhanako.rail.items", "OhkAddonRailCard"),
];

#[no_mangle]
pub extern "C" fn plugin_describe(out: i32, cap: i32) -> i64 {
    let injects: Vec<serde_json::Value> = INJECTS
        .iter()
        .map(|(slot, component)| {
            serde_json::json!({ "slot": slot, "component": component, "priority": 10 })
        })
        .collect();
    let decl = serde_json::json!({
        "name": "demo-openhanako-addon",
        "abi": 1,
        "tools": [],
        "ui": {
            "assets": { "entry.js": include_str!("../js/entry.js") },
            "injects": injects
        }
    })
    .to_string();
    // SAFETY: host guarantees `cap` writable bytes at `out`.
    unsafe { sdk::write_out(out, cap, decl.as_bytes()) }
}
