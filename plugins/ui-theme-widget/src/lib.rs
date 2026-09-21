//! Demo plugin B: mounts into a slot **another plugin** opened.
//!
//! It injects into `ui-llm-panel.config` — a slot that plugin A owns. This is
//! the cross-plugin case: B builds its UI *inside* A. Loading order does not
//! matter (B before A leaves the contribution pending until A appears).


use plugin_sdk as sdk;
#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    println!("ui-theme-widget: up");
    0
}

#[no_mangle]
pub extern "C" fn plugin_shutdown() {}

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

#[no_mangle]
pub extern "C" fn plugin_describe(out: i32, cap: i32) -> i64 {
    let entry_js = r#"
        studio.register("ThemeWidget", (el) => {
            el.innerHTML = '<div style="border:1px solid #2a2a2a;border-radius:6px;'
              + 'padding:8px;font-size:12px;font-family:system-ui">'
              + '<span style="color:#3ecf8e">ui-theme-widget</span> mounted into a slot '
              + '<b>owned by ui-llm-panel</b></div>';
        });
    "#;
    let decl = serde_json::json!({
        "name": "ui-theme-widget",
        "abi": 1,
        "tools": [],
        "ui": {
            "injects": [
                { "slot": "ui-llm-panel.config", "priority": 0, "component": "ThemeWidget" },
                // Also into the built-in tab strip, at a LOWER priority number
                // than ui-llm-panel's default. This makes ui-curator's
                // `priority` adjustment observable: absent the adjustment,
                // theme-widget would sort first.
                { "slot": "settings.tabs", "priority": -50, "component": "ThemeWidget" }
            ],
            "assets": { "entry.js": entry_js }
        }
    })
    .to_string();
    write_out(out, cap, decl.as_bytes())
}

#[no_mangle]
pub extern "C" fn plugin_invoke(_a: i32, _b: i32, _c: i32, _d: i32, _e: i32, _f: i32) -> i64 { -2 }

/// Copy `src` into the guest buffer; `len` / `-needed`, per the ABI.
///
/// Delegated to the SDK: the boundary rule (in particular that `len == cap` is a
/// **success**, not a retry) has one implementation rather than one per plugin.
fn write_out(out: i32, cap: i32, src: &[u8]) -> i64 {
    // SAFETY: the host guarantees `cap` writable bytes at `out`, which is
    // exactly `sdk::write_out`'s precondition.
    unsafe { sdk::write_out(out, cap, src) }
}
