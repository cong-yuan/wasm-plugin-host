//! `hana-shell` — HanaAgent's layout (`liliMozi/openhanako`) as a WASM plugin.
//!
//! It claims the launch view (`open: "startup"`), so the app opens **this**
//! window at startup and keeps its own hidden. That is what makes "the Hana
//! shell is the app" true rather than aspirational: the plugin owns the window,
//! and the studio's own page is a fallback for when no shell is installed.
//!
//! ## The point is the slot surface, not the pixels
//!
//! Every region of HanaAgent's chrome opens a slot, so a plugin written
//! **later** can add a feature with a one-line declaration — no change here, no
//! rebuild, no ordering requirement:
//!
//! ```json
//! "ui": { "injects": [{ "slot": "hana.sidebar.notice", "component": "Status" }] }
//! ```
//!
//! The inventory is declared below in `SLOTS` and mirrored in `js/lib/slots.js`,
//! which is where the panels mount them. Serving the list from the manifest (as
//! `provides`) rather than only from JS means the host can show it in the slot
//! inspector, and a name collision with another plugin is reported as an error
//! instead of silently producing two half-filled regions.
//!
//! ## Two sources, kept separate
//!
//! | Concern | From | Why |
//! |---|---|---|
//! | **Layout** | `liliMozi/openhanako` | The chrome that is being recreated |
//! | **Slot discipline** | `zhu1090093659/dsh-web` | Named regions, explicit order, no DOM surgery |
//!
//! HanaAgent's plugin model is an iframe with an SDK handshake; ours is a slot
//! that renders directly. So the *chrome* is copied and the *plugin surface* is
//! ours — the slot inventory below is the contract that difference produces.
//!
//! ## Naming
//!
//! Slot names follow HanaAgent's regions (`titlebar.…`, `sidebar.…`,
//! `conversation.…`, `preview`, `rail`, `shell.overlay`). The `hana.` prefix is
//! ours: it keeps these distinct from any other plugin's slots.

#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    println!("hana-shell: up (owns the launch view; 17 slots open for later plugins)");
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
pub extern "C" fn plugin_invoke(_a: i32, _b: i32, _c: i32, _d: i32, _e: i32, _f: i32) -> i64 { -2 }

/// Every slot the shell opens, with a one-line description for the inspector.
///
/// Declaring them here (rather than only in JS) is what makes the layout a
/// **contract**: the host knows the surface a plugin host offers, and a second
/// declaration of the same name is an error rather than a silent merge.
///
/// The order mirrors the layout, so "where would this go?" is answerable by
/// reading this list top to bottom.
const SLOTS: &[(&str, &str)] = &[
    // ── Titlebar (44px, the row above everything) ──
    ("hana.titlebar.left", "Left cluster: sidebar toggle, new session"),
    ("hana.titlebar.center", "Centre: the session title / channel tabs"),
    ("hana.titlebar.right", "Right cluster: widget buttons, panel toggles"),

    // ── Left sidebar (240px) ──
    ("hana.sidebar.header", "Header row: title, new-chat, settings, collapse"),
    ("hana.sidebar.activities", "The activity bars: bridge, activity, automation, skills"),
    ("hana.sidebar.sessions", "The session list"),
    ("hana.sidebar.notice", "The notice slot above the footer (update stickers)"),
    ("hana.sidebar.footer", "Sidebar footer: status, account, extra actions"),

    // ── Centre column ──
    ("hana.conversation.header", "Session header: title and actions"),
    ("hana.conversation.hero", "Empty state, shown before the first message"),
    ("hana.conversation.stream", "The message stream itself"),
    ("hana.conversation.input.dock", "Around the composer (above/below the box)"),
    ("hana.conversation.input.right", "Inside the composer, after Send"),

    // ── Preview panel (580px, collapsible) ──
    ("hana.preview.panel", "The right-hand preview/document panel"),

    // ── Right column / rail (260px) ──
    ("hana.rail.header", "Right column header row"),
    ("hana.rail.items", "Right column body (activity, todos, files)"),

    // ── Frame level ──
    ("hana.shell.overlay", "Spans the whole window, above everything"),
];

/// Assets, each a real file pulled in at compile time. The script text stays a
/// `.js` file — formattable, diffable, reviewable — while still travelling
/// inside the `.wasm`, which is all the host ever receives.
const ASSETS: &[(&str, &str)] = &[
    ("lib/dom.js", include_str!("../js/lib/dom.js")),
    ("lib/tokens.js", include_str!("../js/lib/tokens.js")),
    ("lib/motion.js", include_str!("../js/lib/motion.js")),
    ("lib/slots.js", include_str!("../js/lib/slots.js")),
    ("lib/resize.js", include_str!("../js/lib/resize.js")),
    ("lib/api.js", include_str!("../js/lib/api.js")),
    ("panels/titlebar.js", include_str!("../js/panels/titlebar.js")),
    ("panels/sidebar.js", include_str!("../js/panels/sidebar.js")),
    ("panels/conversation.js", include_str!("../js/panels/conversation.js")),
    ("panels/preview.js", include_str!("../js/panels/preview.js")),
    ("panels/rail.js", include_str!("../js/panels/rail.js")),
    ("panels/shell.js", include_str!("../js/panels/shell.js")),
    ("style.css", include_str!("../js/style.css")),
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
        "name": "hana-shell",
        "abi": 1,
        "tools": [],
        "ui": {
            "assets": assets,
            "provides": provides,
            "windows": [{
                "name": "main",
                "component": "HanaShell",
                "title": "Hana",
                "width": 1440,
                "height": 900,
                "open": "startup"
            }]
        }
    })
    .to_string();
    write_out(out, cap, decl.as_bytes())
}

fn write_out(out: i32, cap: i32, src: &[u8]) -> i64 {
    if out == 0 || src.len() > cap.max(0) as usize {
        return -(src.len() as i64);
    }
    unsafe { std::ptr::copy_nonoverlapping(src.as_ptr(), out as *mut u8, src.len()) };
    src.len() as i64
}
