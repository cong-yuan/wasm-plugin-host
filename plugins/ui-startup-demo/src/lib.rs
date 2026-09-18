//! Demo plugin: **owns the launch view**.
//!
//! Declares a window with `open: "startup"`. At startup the app opens this
//! window and keeps its own window hidden, so the user lands here instead of the
//! default dashboard. Unlike `open: "auto"` — which opens whenever the plugin
//! activates — `startup` applies **only at launch**, and at most one plugin may
//! declare it.
//!
//! Close the window and the app's own window appears, so this is never a trap.

#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    println!("ui-startup-demo: up (this plugin owns the launch view)");
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
    let entry_js = r##"
        studio.register("StartupHome", (el) => {
            el.innerHTML =
              '<div style="padding:32px;font-family:system-ui;color:#ededed">'
            +   '<h1 style="margin:0 0 8px">Startup window</h1>'
            +   '<p style="color:#8f8f8f;max-width:52ch;line-height:1.6">'
            +     'This window opened <b>at launch, instead of the app default page</b>, '
            +     'because the plugin declared <code>open: "startup"</code>.'
            +   '</p>'
            +   '<p style="color:#8f8f8f;max-width:52ch;line-height:1.6">'
            +     'Close it and the app&rsquo;s own window appears — the plugin can never '
            +     'strand you with no window.'
            +   '</p>'
            +   '<div style="display:flex;gap:8px;margin-top:16px">'
            +     '<button id="back">Open the app window</button>'
            +   '</div>'
            + '</div>';
            el.querySelector("#back").onclick = () => studio.closeWindow("home");
        });
    "##;

    let decl = serde_json::json!({
        "name": "ui-startup-demo",
        "abi": 1,
        "tools": [],
        "ui": {
            "assets": { "entry.js": entry_js },
            "windows": [{
                "name": "home",
                "component": "StartupHome",
                "title": "Startup demo — this is the launch view",
                "width": 760,
                "height": 460,
                "open": "startup"
            }]
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
