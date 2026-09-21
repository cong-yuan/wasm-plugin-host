//! A plugin that ONLY uses std `println!`/`eprintln!` — no host.log glue.


use plugin_sdk as sdk;
#[no_mangle]
pub extern "C" fn plugin_abi_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn plugin_init() -> i32 {
    println!("rust stdout line 1");
    println!("rust stdout line 2");
    eprintln!("rust stderr diagnostic");
    0
}

#[no_mangle] pub extern "C" fn plugin_shutdown() {}

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
    let d = br#"{"name":"plain-rust","abi":1,"tools":[]}"#;
    if out == 0 || d.len() > cap.max(0) as usize { return -(d.len() as i64); }
    unsafe { std::ptr::copy_nonoverlapping(d.as_ptr(), out as *mut u8, d.len()); }
    d.len() as i64
}

#[no_mangle]
pub extern "C" fn plugin_invoke(_a: i32,_b: i32,_c: i32,_d: i32,_o: i32,_cap: i32) -> i64 { 0 }
