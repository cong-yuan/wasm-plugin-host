//! `qoder-shell` — the Qoder CN shell, recreated as a WASM plugin.
//!
//! It declares a window with `open: "startup"`, so the app opens **this**
//! window at launch and keeps its own hidden: the user lands on the shell, not
//! on the default page.
//!
//! ## Why the JS lives in real files
//!
//! Every asset is pulled in with `include_str!` from `../js/`, so the script
//! text is a `.js` file — syntax-highlighted, formattable, diffable — rather
//! than a `r#"..."#` literal. The asset still travels *inside* the `.wasm`
//! (the host only ever receives the module), but nothing is written as a Rust
//! string. That is the whole point: it makes a non-trivial plugin maintainable.
//!
//! The module split mirrors how the shell is composed:
//!
//! * `lib/tokens`    — Qoder's design tokens and its nine themes
//! * `lib/dom`       — a tiny element builder
//! * `lib/nav`       — Qoder's main navigation
//! * `lib/api`       — the backend commands the shell drives
//! * `panels/sidebar`, `panels/inspector`, `panels/chat`, `panels/shell`
//! * `entry.js`      — applies the theme, registers the component, opens a slot

#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    println!("qoder-shell: up (this plugin owns the launch view)");
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

/// The plugin's assets, each a real file next to this crate.
const ASSETS: &[(&str, &str)] = &[
    ("lib/tokens.js", include_str!("../js/lib/tokens.js")),
    ("lib/dom.js", include_str!("../js/lib/dom.js")),
    ("lib/nav.js", include_str!("../js/lib/nav.js")),
    ("lib/api.js", include_str!("../js/lib/api.js")),
    ("panels/sidebar.js", include_str!("../js/panels/sidebar.js")),
    ("panels/inspector.js", include_str!("../js/panels/inspector.js")),
    ("panels/chat.js", include_str!("../js/panels/chat.js")),
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

    let decl = serde_json::json!({
        "name": "qoder-shell",
        "abi": 1,
        "tools": [],
        "ui": {
            "assets": assets,
            "windows": [{
                "name": "main",
                "component": "QoderShell",
                "title": "Qoder",
                "width": 1280,
                "height": 820,
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
