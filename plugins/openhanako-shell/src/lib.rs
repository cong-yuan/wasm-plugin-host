//! openhanako-shell — embeds the real openhanako renderer 1:1, and opens a
//! slot surface so later plugins can extend it without touching this crate.
//!
//! The Studio window hosts an iframe pointed at the upstream UI
//! (`npm run dev:web` or a static preview). Inside the iframe, real chrome nodes carry `data-ohk-slot` anchors and a
//! small bridge posts their geometry. This shell mounts `studio.renderSlot`
//! hosts and aligns them to those rects. Empty hosts take no clicks.
//!
//! Chat is a second bridge: the iframe cannot call Tauri, so `js/lib/host-bridge.js`
//! (same webview as Svelte) accepts `postMessage` and invokes `list_sessions` /
//! `send_message` / `transcript`. Rust slot names stay unchanged.
//!
//! ## Slot contract vs upstream
//!
//! Upstream openhanako (page / widget / card / settingsTab) is an iframe island
//! model. Our contract is the WASM describe surface:
//!
//! | Concern | Mechanism |
//! |---|---|
//! | Chrome regions later plugins may fill | `ui.provides` (`openhanako.*`) |
//! | Contributions from other plugins | `ui.injects` → `studio.renderSlot` |
//! | Hide / reorder / replace those | `ui.adjusts` (e.g. `ui-curator`) |
//!
//! Names use the `openhanako.` prefix so they stay distinct from `hana-shell`'s
//! `hana.*` inventory. Keep `SLOTS` here in lockstep with `js/lib/slots.js`.

use plugin_sdk as sdk;

#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    println!("openhanako-shell: embedding real openhanako UI + {} slots", SLOTS.len());
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

/// Every slot the shell opens. Mirrored in `js/lib/slots.js`.
const SLOTS: &[(&str, &str)] = &[
    // Titlebar
    ("openhanako.titlebar.left", "Left cluster overlay (sidebar toggle side)"),
    ("openhanako.titlebar.center", "Centre title / channel tabs overlay"),
    ("openhanako.titlebar.right", "Right cluster overlay (widget / panel toggles)"),
    // Left sidebar
    ("openhanako.sidebar.header", "Sidebar header row overlay"),
    ("openhanako.sidebar.activities", "Activity bars overlay"),
    ("openhanako.sidebar.sessions", "Session list overlay / below-list strip"),
    ("openhanako.sidebar.notice", "Notice strip above sidebar footer"),
    ("openhanako.sidebar.footer", "Sidebar footer overlay"),
    // Centre column
    ("openhanako.conversation.header", "Conversation header overlay"),
    ("openhanako.conversation.hero", "Empty-state / hero overlay"),
    ("openhanako.conversation.stream", "Message stream side overlay"),
    ("openhanako.conversation.input.dock", "Around the composer (above/below)"),
    ("openhanako.conversation.input.right", "Inside composer area, after Send"),
    // Preview + rail
    ("openhanako.preview.panel", "Right-hand preview panel overlay"),
    ("openhanako.rail.header", "Right rail header overlay"),
    ("openhanako.rail.items", "Right rail body overlay"),
    // Frame
    ("openhanako.shell.overlay", "Full-window overlay above the iframe"),
];

const ASSETS: &[(&str, &str)] = &[
    ("lib/slots.js", include_str!("../js/lib/slots.js")),
    ("lib/bridge.js", include_str!("../js/lib/bridge.js")),
    ("lib/tauri-invoke.js", include_str!("../js/lib/tauri-invoke.js")),
    ("lib/api.js", include_str!("../js/lib/api.js")),
    ("lib/hana-adapter.js", include_str!("../js/lib/hana-adapter.js")),
    ("lib/host-bridge.js", include_str!("../js/lib/host-bridge.js")),
    ("entry.js", include_str!("../js/entry.js")),
];

#[no_mangle]
pub extern "C" fn plugin_describe(out: i32, cap: i32) -> i64 {
    let assets: serde_json::Map<String, serde_json::Value> = ASSETS
        .iter()
        .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.to_string())))
        .collect();

    let provides: Vec<serde_json::Value> = SLOTS
        .iter()
        .map(|(name, description)| serde_json::json!({ "name": name, "description": description }))
        .collect();

    let decl = serde_json::json!({
        "name": "openhanako-shell",
        "abi": 1,
        "tools": [],
        "ui": {
            "assets": assets,
            "provides": provides,
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
    // SAFETY: host guarantees `cap` writable bytes at `out`.
    unsafe { sdk::write_out(out, cap, decl.as_bytes()) }
}
