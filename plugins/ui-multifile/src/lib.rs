//! `ui-multifile` — proves a plugin can be more than one file.
//!
//! Its `ui.assets` contains four `.js` entries:
//!
//! * `lib/dom.js`     — a tiny helper the others build on
//! * `lib/stats.js`   — a domain helper, which itself requires `lib/dom`
//! * `panels.js`      — registers the components
//! * `entry.js`       — three lines: require, wire, done
//!
//! The point is that `entry.js` stays readable. Before this, every plugin was
//! one `entry.js` string, so anything non-trivial became a wall of concatenated
//! text. Modules are loaded lazily and cached, and may require each other.

#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    println!("ui-multifile: up (entry.js is 3 lines; the rest lives in modules)");
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

/// A small DOM builder, so the panel code below reads as structure rather than
/// string concatenation. This is the module the others require.
const LIB_DOM: &str = r#"
    const h = (tag, attrs, ...kids) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (k === "style") el.setAttribute("style", v);
            else if (k === "text") el.textContent = v;
            else el.setAttribute(k, v);
        }
        for (const k of kids) el.appendChild(k);
        return el;
    };
    return { h };
"#;

/// Domain logic, written against `lib/dom` to show modules requiring modules.
const LIB_STATS: &str = r#"
    const { h } = studio.require("lib/dom");
    const row = (label, value) =>
        h("div", { style: "display:flex;justify-content:space-between;font-size:12px;padding:2px 0" },
            h("span", { style: "color:#8f8f8f", text: label }),
            h("span", { style: "color:#ededed", text: String(value) }));
    return { row };
"#;

/// The components. Registers two, so the plugin shows up in two places.
const PANELS: &str = r#"
    const { h } = studio.require("lib/dom");
    const { row } = studio.require("lib/stats");

    studio.register("MultiFilePanel", (el) => {
        el.appendChild(h("div", { style: "font-family:system-ui" },
            h("strong", { text: "ui-multifile" }),
            h("p", { style: "color:#8f8f8f;font-size:12px;margin:4px 0 8px",
                     text: "this panel's code lives in a separate .js asset" }),
            row("modules loaded", 3),
            row("entry.js lines", 3)));
    });

    studio.register("MultiFilePage", (el) => {
        el.appendChild(h("div", { style: "font-family:system-ui" },
            h("p", { style: "color:#8f8f8f;font-size:13px",
                     text: "This whole page is contributed by a WASM plugin. "
                         + "Its route and its sidebar entry were declared once." }),
            row("declared in", "ui.routes"),
            row("rendered by", "MultiFilePage (a module asset)")));
    });

    studio.register("MultiFileBadge", (el) => {
        el.appendChild(h("span", {
            style: "border:1px solid #2a2a2a;border-radius:6px;padding:4px 8px;"
                 + "font-size:12px;font-family:system-ui",
            text: "ui-multifile (模块化插件)",
        }));
    });
"#;

/// The entry: require the panels module, then claim a place. That is all.
const ENTRY_JS: &str = r#"
    studio.require("panels");
    studio.inject("settings.tabs", "MultiFilePanel", 100);
    studio.inject("dashboard.cards", "MultiFileBadge", 100);
"#;

#[no_mangle]
pub extern "C" fn plugin_describe(out: i32, cap: i32) -> i64 {
    let decl = serde_json::json!({
        "name": "ui-multifile",
        "abi": 1,
        "tools": [],
        "ui": {
            "assets": {
                "lib/dom.js": LIB_DOM,
                "lib/stats.js": LIB_STATS,
                "panels.js": PANELS,
                "entry.js": ENTRY_JS
            },
            // One declaration yields both the page and its sidebar entry, so
            // they cannot drift apart.
            "routes": [
                {
                    "path": "multifile",
                    "component": "MultiFilePage",
                    "title": "Multi-file demo",
                    "icon": "▤",
                    "nav": true
                }
            ]
        }
    })
    .to_string();
    write_out(out, cap, decl.as_bytes())
}

#[no_mangle]
pub extern "C" fn plugin_invoke(_a: i32, _b: i32, _c: i32, _d: i32, _e: i32, _f: i32) -> i64 { -2 }

fn write_out(out: i32, cap: i32, src: &[u8]) -> i64 {
    if out == 0 || src.len() > cap.max(0) as usize { return -(src.len() as i64); }
    unsafe { std::ptr::copy_nonoverlapping(src.as_ptr(), out as *mut u8, src.len()) };
    src.len() as i64
}
