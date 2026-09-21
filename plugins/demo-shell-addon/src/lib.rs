//! `demo-shell-addon` — a second plugin that extends `hana-shell`.
//!
//! It exists to demonstrate the compatibility guarantee: it contributes to four
//! of the shell's slots while knowing **nothing** about the shell's internals.
//! If the shell is rewritten, this keeps working as long as the slot names hold.


use plugin_sdk as sdk;
#[no_mangle] pub extern "C" fn plugin_abi_version() -> i32 { 1 }
#[no_mangle] pub extern "C" fn plugin_init() -> i32 {
    println!("demo-shell-addon: up (extends hana-shell through its slots)");
    0
}
#[no_mangle] pub extern "C" fn plugin_shutdown() {}
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

#[no_mangle] pub extern "C" fn plugin_invoke(_a: i32, _b: i32, _c: i32, _d: i32, _e: i32, _f: i32) -> i64 { -2 }

/// The slots this plugin fills. Declared so the host can show the wiring in the
/// slot inspector without running the plugin's JS.
const INJECTS: &[(&str, &str)] = &[
    ("hana.sidebar.sessions", "AddonSidebarRows"),
    ("hana.titlebar.right", "AddonHeaderButton"),
    ("hana.conversation.input.right", "AddonComposerChip"),
    ("hana.rail.items", "AddonDetailsPanel"),
];

#[no_mangle]
pub extern "C" fn plugin_describe(out: i32, cap: i32) -> i64 {
    let injects: Vec<serde_json::Value> = INJECTS
        .iter()
        .map(|(slot, component)| serde_json::json!({ "slot": slot, "component": component, "priority": 10 }))
        .collect();
    let decl = serde_json::json!({
        "name": "demo-shell-addon", "abi": 1, "tools": [],
        "ui": {
            "assets": { "entry.js": include_str!("../js/entry.js") },
            "injects": injects
        }
    })
    .to_string();
    write_out(out, cap, decl.as_bytes())
}

/// Copy `src` into the guest buffer; `len` / `-needed`, per the ABI.
///
/// Delegated to the SDK: the boundary rule (in particular that `len == cap` is a
/// **success**, not a retry) has one implementation rather than one per plugin.
fn write_out(out: i32, cap: i32, src: &[u8]) -> i64 {
    // SAFETY: the host guarantees `cap` writable bytes at `out`, which is
    // exactly `sdk::write_out`'s precondition.
    unsafe { sdk::write_out(out, cap, src) }
}
