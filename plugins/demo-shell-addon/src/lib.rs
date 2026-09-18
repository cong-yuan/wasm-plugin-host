//! `demo-shell-addon` — a second plugin that extends `dsh-web-shell`.
//!
//! It exists to demonstrate the compatibility guarantee: it contributes to four
//! of the shell's slots while knowing **nothing** about the shell's internals.
//! If the shell is rewritten, this keeps working as long as the slot names hold.

#[no_mangle] pub extern "C" fn plugin_abi_version() -> i32 { 1 }
#[no_mangle] pub extern "C" fn plugin_init() -> i32 {
    println!("demo-shell-addon: up (extends dsh-web-shell through its slots)");
    0
}
#[no_mangle] pub extern "C" fn plugin_shutdown() {}
#[no_mangle] pub extern "C" fn plugin_alloc(n: i32) -> i32 {
    let mut v = Vec::<u8>::with_capacity(n.max(0) as usize);
    let p = v.as_mut_ptr() as i32; std::mem::forget(v); p
}
#[no_mangle] pub extern "C" fn plugin_free(_p: i32, _n: i32) {}
#[no_mangle] pub extern "C" fn plugin_invoke(_a: i32, _b: i32, _c: i32, _d: i32, _e: i32, _f: i32) -> i64 { -2 }

/// The slots this plugin fills. Declared so the host can show the wiring in the
/// slot inspector without running the plugin's JS.
const INJECTS: &[(&str, &str)] = &[
    ("dsh-web.sidebar.items", "AddonSidebarRows"),
    ("dsh-web.conversation.header.actions", "AddonHeaderButton"),
    ("dsh-web.conversation.input.right", "AddonComposerChip"),
    ("dsh-web.details.items", "AddonDetailsPanel"),
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

fn write_out(out: i32, cap: i32, src: &[u8]) -> i64 {
    if out == 0 || src.len() > cap.max(0) as usize { return -(src.len() as i64); }
    unsafe { std::ptr::copy_nonoverlapping(src.as_ptr(), out as *mut u8, src.len()) };
    src.len() as i64
}
