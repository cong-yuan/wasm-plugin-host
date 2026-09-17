//! `ui-curator` — a plugin whose entire purpose is to reshape *other* plugins'
//! UI at runtime.
//!
//! It demonstrates the three adjustments that make the feature useful:
//!
//! * **hide** — suppress a contribution without unloading its plugin;
//! * **priority** — reorder a slot so the most useful panel comes first;
//! * **replace** — substitute a component of its own for another plugin's.
//!
//! Crucially it touches none of those plugins' code, and it can be loaded
//! before or after them: adjustments are applied at *resolution* time, so a
//! `hide` that arrives before the target contribution simply applies when it
//! shows up.
//!
//! Load this plugin last and it curates everything below it. Unload it and the
//! UI returns to exactly what the other plugins declared.

#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    println!("ui-curator: up (this plugin only reshapes others' UI)");
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
pub extern "C" fn plugin_describe(out: i32, cap: i32) -> i64 {
    // The component that `replace` substitutes for another plugin's panel.
    let entry_js = r#"
        studio.register("CuratedPanel", (el, ctx) => {
            el.innerHTML =
              '<div style="font-family:system-ui;border:1px solid #3ecf8e55;'
              + 'border-radius:6px;padding:10px;background:#3ecf8e0d">'
              + '<div style="font-size:12px;color:#3ecf8e">curated by ui-curator</div>'
              + '<div style="font-size:11px;color:#8f8f8f;margin-top:4px">'
              +   'ui-curator replaced the panel from <b>' + ctx.owner + '</b> '
              +   '(originally component "' + ctx.component + '")'
              + '</div></div>';
        });
    "#;

    let decl = serde_json::json!({
        "name": "ui-curator",
        "abi": 1,
        "tools": [],
        "ui": {
            "assets": { "entry.js": entry_js },

            // No `provides`, no `injects` — only `adjusts`. That is the point.
            "adjusts": [
                // 1. Reorder: pull the LLM panel to the front of settings.tabs.
                {
                    "slot": "settings.tabs",
                    "from": "ui-llm-panel",
                    "action": "priority",
                    "to": -100
                },
                // 2. Replace: render our own panel in its place, so we can see
                //    the substitution working end to end.
                {
                    "slot": "ui-llm-panel.config",
                    "from": "ui-theme-widget",
                    "action": "replace",
                    "component": "CuratedPanel"
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
