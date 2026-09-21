//! `host.http_fetch` must not be able to hang the host.
//!
//! The call runs while the host holds its registry lock (see the ABI's Threading
//! section), so an `http_fetch` that never returns does not stall only its own
//! plugin — it stops every other slot and every read of host state, for as long
//! as the far end stays quiet. ureq's default is *no timeout at all*, so before
//! this bound existed an endpoint that accepted the TCP connection and then sent
//! nothing froze the whole host indefinitely.
//!
//! Reproduced end to end here: a listener that accepts and is deliberately
//! silent, a guest that calls `host.http_fetch` against it, and an assertion
//! that the call comes back on the timeout rather than hanging.

use std::io::Read;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use wasm_plugin_host::{Registry, Runtime};

/// A guest exporting one tool whose whole body is "call `host.http_fetch`
/// against the URL in the request".
fn silent_fetch_guest(url: &str) -> Vec<u8> {
    let decl = r#"{"name":"net","abi":1,"tools":[{"name":"net_tool","description":"t","exec":"go"}]}"#;
    let req = format!(r#"{{"url":"{url}"}}"#);
    let (d, q) = (1024usize, 8192usize);
    let wat = format!(
        r#"(module
          (import "host" "http_fetch" (func $f (param i32 i32 i32 i32) (result i64)))
          (memory (export "memory") 16)
          (global $bump (mut i32) (i32.const 65536))
          (data (i32.const {d}) {decl:?})
          (data (i32.const {q}) {req:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32) (local $p i32)
            (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n))) (local.get $p))
          (func (export "plugin_free") (param $p i32) (param $n i32)
            (global.set $bump (local.get $p)))
          (func $blit (param $s i32) (param $l i32) (param $o i32) (param $c i32) (result i64)
            (local $i i32)
            (if (i32.lt_s (local.get $c) (local.get $l))
              (then (return (i64.extend_i32_s (i32.sub (i32.const 0) (local.get $l))))))
            (block $dd (loop $L
              (br_if $dd (i32.ge_s (local.get $i) (local.get $l)))
              (i32.store8 (i32.add (local.get $o) (local.get $i))
                           (i32.load8_u (i32.add (local.get $s) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $L)))
            (i64.extend_i32_s (local.get $l)))
          (func (export "plugin_describe") (param $o i32) (param $c i32) (result i64)
            (call $blit (i32.const {d}) (i32.const {dl}) (local.get $o) (local.get $c)))
          (func (export "plugin_invoke") (param i32 i32 i32 i32) (param $o i32) (param $c i32) (result i64)
            (local $n i64)
            (local.set $n (call $f (i32.const {q}) (i32.const {ql}) (i32.const 32768) (i32.const 16384)))
            (call $blit (i32.const 32768) (i32.wrap_i64 (local.get $n)) (local.get $o) (local.get $c)))
        )"#,
        d = d,
        q = q,
        decl = decl,
        req = req,
        dl = decl.len(),
        ql = req.len(),
    );
    wat::parse_str(&wat).unwrap()
}

/// A TCP listener that accepts exactly one connection, reads whatever arrives,
/// then stays silent until `stop` is set. Returns its port.
fn silent_server(stop: Arc<AtomicBool>) -> u16 {
    let lis = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = lis.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((mut s, _)) = lis.accept() {
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    });
    port
}

#[test]
fn a_silent_endpoint_does_not_hang_the_call() {
    let stop = Arc::new(AtomicBool::new(false));
    let port = silent_server(stop.clone());
    let url = format!("http://127.0.0.1:{port}/");

    let dir = std::env::temp_dir().join(format!("httptimeout-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("net.wat");
    std::fs::write(&path, silent_fetch_guest(&url)).unwrap();

    // The real bound is 30s; pay 1s instead so the test is quick. The mechanism
    // under test — that the bound is applied at all — is identical.
    let rt = Runtime::new().unwrap();
    let rt = {
        let mut rt = rt;
        rt.set_http_timeout(Duration::from_secs(1));
        rt
    };
    let mut reg = Registry::new(rt);
    reg.load("net", &path, serde_json::Value::Null).unwrap();

    let t = Instant::now();
    // The guest echoes the host's raw `http_fetch` reply as its tool result. That
    // is not a valid tool reply (it has no `kind`), so `call_tool` surfaces it as
    // an error — and the error text is precisely the host's HTTP answer, which is
    // what we want to read. The point of the test is that the call *returns*.
    let err = reg.call_tool("net_tool", &serde_json::json!({})).unwrap_err();
    let waited = t.elapsed();

    stop.store(true, Ordering::SeqCst);
    let _ = std::fs::remove_dir_all(&dir);

    let msg = err.to_string();
    println!("waited {waited:?}; host reply = {msg}");
    assert!(
        waited < Duration::from_secs(10),
        "the call should return on the 1s timeout, but waited {waited:?}"
    );
    assert!(
        msg.contains("timeout"),
        "the host should report a timeout, got {msg:?}"
    );
}

/// A *responsive* endpoint must still be served normally — the bound must not
/// have been bought by breaking ordinary requests.
#[test]
fn a_responsive_endpoint_still_works() {
    let lis = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = lis.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((mut s, _)) = lis.accept() {
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            let body = "hello";
            let _ = std::io::Write::write_all(
                &mut s,
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            );
        }
    });
    let url = format!("http://127.0.0.1:{port}/");

    let dir = std::env::temp_dir().join(format!("httptimeout-ok-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("net.wat");
    std::fs::write(&path, silent_fetch_guest(&url)).unwrap();

    let rt = Runtime::new().unwrap();
    let rt = {
        let mut rt = rt;
        rt.set_http_timeout(Duration::from_secs(5));
        rt
    };
    let mut reg = Registry::new(rt);
    reg.load("net", &path, serde_json::Value::Null).unwrap();

    let err = reg.call_tool("net_tool", &serde_json::json!({})).unwrap_err();
    let _ = std::fs::remove_dir_all(&dir);
    // The guest echoes the host's HTTP reply verbatim, so a normal 200 body is
    // proof the request completed rather than timing out.
    let msg = err.to_string();
    println!("responsive host reply = {msg}");
    assert!(msg.contains("\"status\":200"), "reply was {msg}");
    assert!(msg.contains("hello"), "reply was {msg}");
    assert!(!msg.contains("timeout"), "reply was {msg}");
}
