//! `demo-openhanako-addon` — example components for `openhanako-shell` slots.
//!
//! Declares injects for the main chrome regions so Studio can show a full
//! slot walkthrough. Knows only `openhanako.*` names — no shell internals.

use plugin_sdk as sdk;

#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    println!("demo-openhanako-addon: up ({} slot examples)", INJECTS.len());
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

/// slot → component. Must stay in sync with `js/entry.js`.
const INJECTS: &[(&str, &str)] = &[
    ("openhanako.titlebar.left", "OhkTitlebarLeftBadge"),
    ("openhanako.titlebar.center", "OhkTitlebarCenterHint"),
    ("openhanako.titlebar.right", "OhkTitlebarRightButton"),
    ("openhanako.sidebar.header", "OhkSidebarHeaderTag"),
    ("openhanako.sidebar.activities", "OhkSidebarActivityPill"),
    ("openhanako.sidebar.sessions", "OhkSidebarSessionsRow"),
    ("openhanako.sidebar.notice", "OhkSidebarNotice"),
    ("openhanako.sidebar.footer", "OhkSidebarFooter"),
    ("openhanako.conversation.hero", "OhkConversationHero"),
    ("openhanako.conversation.stream", "OhkConversationStreamMark"),
    ("openhanako.conversation.input.dock", "OhkComposerDockChip"),
    ("openhanako.conversation.input.right", "OhkComposerRightAction"),
    ("openhanako.preview.panel", "OhkPreviewBanner"),
    ("openhanako.rail.header", "OhkRailHeader"),
    ("openhanako.rail.items", "OhkRailCard"),
    ("openhanako.shell.overlay", "OhkShellToast"),
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
