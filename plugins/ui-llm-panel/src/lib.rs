//! Demo plugin A: brings its own frontend UI.
//!
//! * opens a slot `ui-llm-panel.config` for OTHER plugins to fill
//! * contributes a panel into the built-in `settings.tabs`
//! * ships an `entry.js` that registers its components
//!
//! It shows the backend+frontend story in one wasm: the same file both
//! declares UI (in `plugin_describe`) and carries the JS that renders it.

#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    println!("ui-llm-panel: up");
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

/// The declaration, with a `ui` block. Serialised with serde_json so the
/// embedded JS string is escaped correctly.
#[no_mangle]
pub extern "C" fn plugin_describe(out: i32, cap: i32) -> i64 {
    let entry_js = r#"
        studio.register("LlmPanel", (el) => {
            el.innerHTML =
              '<div style="font-family:system-ui">'
              + '<strong>LLM provider panel</strong>'
              + '<p style="color:#8f8f8f;font-size:12px">from ui-llm-panel (wasm plugin)</p>'
              + '<button id="ping">test connection</button>'
              + '<pre id="out" style="font-size:11px"></pre>'
              + '<div style="margin-top:10px;border-top:1px solid #2a2a2a;padding-top:8px">'
              + '  <div style="font-size:11px;color:#8f8f8f;margin-bottom:6px">'
              + '    contributed by other plugins (slot: ui-llm-panel.config)</div>'
              + '  <div id="sub" style="min-height:24px"></div>'
              + '</div></div>';
            const b = el.querySelector('#ping');
            const o = el.querySelector('#out');
            if (b && o) b.addEventListener('click', () => {
                o.textContent = 'ok — handled inside the plugin UI';
            });
            // The half that makes an opened slot visible: render its children
            // into our own DOM. Without this call, contributors never appear.
            const sub = el.querySelector('#sub');
            const dispose = sub ? studio.renderSlot('ui-llm-panel.config', sub) : null;
            return () => { if (dispose) dispose(); };
        });
    "#;
    let decl = serde_json::json!({
        "name": "ui-llm-panel",
        "abi": 1,
        "tools": [],
        "ui": {
            "provides": [
                { "name": "ui-llm-panel.config", "description": "settings contributed by other plugins" }
            ],
            "injects": [
                { "slot": "settings.tabs", "priority": 10, "component": "LlmPanel" }
            ],
            "assets": { "entry.js": entry_js }
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
