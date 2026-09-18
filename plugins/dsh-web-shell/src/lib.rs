//! `dsh-web-shell` — the shell from `zhu1090093659/dsh-web`, as a WASM plugin.
//!
//! It claims the launch view (`open: "startup"`), so the app opens **this**
//! window at startup and keeps its own hidden.
//!
//! ## The point is the slot surface, not the pixels
//!
//! Every region of the three-column layout opens a slot, so a plugin written
//! **later** can add a feature with a one-line declaration — no change here, no
//! rebuild, no ordering requirement:
//!
//! ```json
//! "ui": { "injects": [{ "slot": "dsh-web.sidebar.footer", "component": "Status" }] }
//! ```
//!
//! The inventory is declared below in `SLOTS` and mirrored in `js/lib/slots.js`,
//! which is where the panels mount them. Serving the list from the manifest (as
//! `provides`) rather than only from JS means the host can show it in the slot
//! inspector, and a name collision with another plugin is reported as an error
//! instead of silently producing two half-filled regions.
//!
//! ## Naming
//!
//! Slot names follow dsh-web's `data-slot` convention (`sidebar.…`,
//! `conversation.…`, `details`, `shell.overlay`) so the layout reads the same as
//! the project this recreates. The `dsh-web.` prefix is ours: it keeps these
//! distinct from any other plugin's slots.

#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    println!("dsh-web-shell: up (owns the launch view; 12 slots open for later plugins)");
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
const SLOTS: &[(&str, &str)] = &[
    ("dsh-web.sidebar.brand", "Beside the brand mark, top of the sidebar"),
    ("dsh-web.sidebar.actions", "Icon buttons in the sidebar header row"),
    ("dsh-web.sidebar.items", "The main sidebar list, below the header"),
    ("dsh-web.sidebar.footer", "Sidebar footer: status, account, extra actions"),
    ("dsh-web.conversation.header.actions", "Buttons in the session header"),
    ("dsh-web.conversation.hero", "Empty-state area, shown before the first message"),
    ("dsh-web.conversation.overlay", "Floated over the message stream"),
    ("dsh-web.conversation.input.dock", "Around the composer (above/below the box)"),
    ("dsh-web.conversation.input.right", "Right of the send button, inside the composer"),
    ("dsh-web.details.header", "Right column header row"),
    ("dsh-web.details.items", "Right column body"),
    ("dsh-web.shell.overlay", "Spans the whole window, above everything"),
];

/// Assets, each a real file pulled in at compile time. The script text stays a
/// `.js` file — formattable, diffable, reviewable — while still travelling
/// inside the `.wasm`, which is all the host ever receives.
const ASSETS: &[(&str, &str)] = &[
    ("lib/dom.js", include_str!("../js/lib/dom.js")),
    ("lib/tokens.js", include_str!("../js/lib/tokens.js")),
    ("lib/slots.js", include_str!("../js/lib/slots.js")),
    ("lib/api.js", include_str!("../js/lib/api.js")),
    ("panels/sidebar.js", include_str!("../js/panels/sidebar.js")),
    ("panels/conversation.js", include_str!("../js/panels/conversation.js")),
    ("panels/details.js", include_str!("../js/panels/details.js")),
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
        "name": "dsh-web-shell",
        "abi": 1,
        "tools": [],
        "ui": {
            "assets": assets,
            "provides": provides,
            "windows": [{
                "name": "main",
                "component": "DshWebShell",
                "title": "dsh",
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
