//! Demo plugin A: brings its own frontend UI.
//!
//! * opens a slot `ui-llm-panel.config` for OTHER plugins to fill
//! * contributes a panel into the built-in `settings.tabs`
//! * ships an `entry.js` that registers its components
//!
//! It shows the backend+frontend story in one wasm: the same file both
//! declares UI (in `plugin_describe`) and carries the JS that renders it.


use plugin_sdk as sdk;
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
    sdk::alloc_block(n)
}

#[no_mangle]
pub extern "C" fn plugin_free(p: i32, n: i32) {
    // SAFETY: the host only ever frees a pair it previously got from
    // `plugin_alloc`, which is this plugin's only allocator.
    unsafe { sdk::free_block(p, n) }
}

/// The declaration, with a `ui` block. Serialised with serde_json so the
/// embedded JS string is escaped correctly.
#[no_mangle]
pub extern "C" fn plugin_describe(out: i32, cap: i32) -> i64 {
    let entry_js = r#"
        studio.register("LlmAdvanced", (el) => {
            el.innerHTML =
              '<div style="font-family:system-ui;padding:8px">'
              + '<h2 style="margin:0 0 4px">Advanced LLM settings</h2>'
              + '<p style="color:#8f8f8f;font-size:12px">'
              + 'this whole window is a component from ui-llm-panel</p>'
              + '<label style="display:block;margin-top:12px;font-size:12px;color:#8f8f8f">'
              + 'temperature<input id="t" type="range" min="0" max="2" step="0.1" value="0.7" style="width:100%"></label>'
              + '<pre id="tv" style="font-size:11px"></pre>'
              + '<div id="sub" style="margin-top:16px;border-top:1px solid #2a2a2a;padding-top:10px"></div>'
              + '<button id="openwin" style="margin-top:12px">open advanced in a new window</button>'
              + '<button id="openhtml" style="margin-top:12px;margin-left:6px">open standalone page</button>'
              + '</div>';
            const t = el.querySelector('#t');
            const tv = el.querySelector('#tv');
            if (t && tv) {
                const show = () => { tv.textContent = 'temperature = ' + t.value; };
                t.addEventListener('input', show); show();
            }
            // Open a declared window, passing params it reads on startup.
            const ob = el.querySelector('#openwin');
            if (ob) ob.addEventListener('click', () => {
                studio.openWindow('advanced', { temperature: t ? t.value : null });
            });
            const oh = el.querySelector('#openhtml');
            if (oh) oh.addEventListener('click', () => {
                studio.openWindow('standalone', { from: 'ui-llm-panel' });
            });
            // A window can host slots too.
            const sub = el.querySelector('#sub');
            const d = sub ? studio.renderSlot('ui-llm-panel.config', sub) : null;
            return () => { if (d) d(); };
        });
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
            "assets": { "entry.js": entry_js },
            "windows": [
                {
                    "name": "advanced",
                    "component": "LlmAdvanced",
                    "title": "LLM — Advanced",
                    "width": 620,
                    "height": 480,
                    "open": "manual",
                    "content": "app"
                },
                {
                    "name": "standalone",
                    "component": "",
                    "title": "LLM — Standalone page",
                    "width": 520,
                    "height": 360,
                    "open": "manual",
                    "content": "html",
                    "html": "<style>body{font-family:system-ui;background:#0f0f0f;color:#ededed;padding:24px}h1{font-size:18px;margin:0 0 8px}pre{background:#161616;padding:10px;border-radius:6px;font-size:12px}</style><h1>Standalone page</h1><p style=\"color:#8f8f8f;font-size:13px\">This whole window is HTML supplied by the plugin — no app shell.</p><pre id=out>reading params…</pre><script>setTimeout(()=>{const p=(window.__STUDIO_WINDOW__||{}).params||null;document.getElementById('out').textContent='params = '+JSON.stringify(p);},50)</script>"
                }
            ]
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
