//! ABI: a plugin instance is never entered while it is already running.
//!
//! This is a **contract, not an implementation detail**. Plugins written in Rust
//! keep mutable globals — `plugins/hello-rust` caches its config in a
//! `static mut` — and that is only sound because a single instance is never
//! re-entered. The claim was previously nowhere: not in `docs/ABI.md`, and not
//! in a test. It lived only as a side effect of wasmtime's `Store` not being
//! `Sync`, so a change that reused an instance across threads (a pool keyed by
//! plugin instead of by slot) would have silently turned every plugin's globals
//! into a data race, with nothing to notice.
//!
//! ## Two layers, tested separately
//!
//! * **The ABI floor (per instance).** One slot, many threads: no overlap ever.
//!   This must hold regardless of which API drives the calls.
//! * **`WasmHost`'s stronger guarantee (global).** `WasmHost` holds one registry
//!   lock for the whole call, so even *different* slots are serialised through
//!   it. The studio relies on this. It is deliberately stronger than the ABI
//!   requires, and `Registry::call_many_parallel` shows the ABI does **not**
//!   promise it — so these are two tests, not one, and the comments say which
//!   layer each is pinning.
//!
//! ## How overlap is observed
//!
//! A guest cannot see the scheduler, but the host can: the log hook runs during
//! a guest call, on the calling thread. If two calls into one instance ever
//! overlapped, hook entries would nest. Counting concurrent hook entries
//! therefore detects overlap without instrumenting the guest at all. (That the
//! counter is *sensitive* was verified separately: under genuinely concurrent
//! hook calls it reports 4.)

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dsh_wasm_host::{HostOptions, WasmHost};
use wasm_plugin_host::LogHook;

use common::{tmpdir, write_wasm};

/// A host whose log hook reports the peak number of simultaneously-entered hook
/// calls, and how many guest calls it saw at all.
fn observing_host(peak: Arc<AtomicUsize>, seen: Arc<AtomicUsize>) -> WasmHost {
    let in_hook = Arc::new(AtomicUsize::new(0));
    let hook: LogHook = Arc::new(move |_rec| {
        let now = in_hook.fetch_add(1, Ordering::SeqCst) + 1;
        peak.fetch_max(now, Ordering::SeqCst);
        seen.fetch_add(1, Ordering::SeqCst);
        // Hold the entry briefly so an overlap has a real chance to show up
        // rather than depending on a lucky interleaving.
        std::thread::sleep(Duration::from_millis(5));
        in_hook.fetch_sub(1, Ordering::SeqCst);
    });
    WasmHost::with_options(HostOptions {
        log_hook: Some(hook),
        ..Default::default()
    })
    .expect("host builds")
}

/// A module whose `plugin_invoke` logs on entry, so a guest call is observable
/// from the host side.
fn wasm_that_logs_on_invoke(slot: &str) -> Vec<u8> {
    let decl = format!(
        r#"{{"name":"{slot}","abi":1,"tools":[{{"name":"{slot}_tool","description":"t","exec":"go"}}]}}"#
    );
    let reply = r#"{"kind":"success","content":"ok","value":{}}"#;
    build_logging(&decl, reply)
}

/// Like `common::build`, but `plugin_invoke` logs before replying.
fn build_logging(decl: &str, reply: &str) -> Vec<u8> {
    let msg = "invoked";
    let msg_off = 64usize;
    let decl_off = 128usize;
    let res_off = decl_off + decl.len();
    let wat = format!(
        r#"(module
          (import "host" "log" (func $log (param i32 i32 i32)))
          (memory (export "memory") 16)
          (global $bump (mut i32) (i32.const 8192))
          (data (i32.const {msg_off}) {msg:?})
          (data (i32.const {decl_off}) {decl:?})
          (data (i32.const {res_off}) {reply:?})
          (func (export "plugin_abi_version") (result i32) (i32.const 1))
          (func (export "plugin_init") (result i32) (i32.const 0))
          (func (export "plugin_shutdown"))
          (func (export "plugin_alloc") (param $n i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $bump))
            (global.set $bump (i32.add (global.get $bump) (local.get $n)))
            (local.get $p))
          (func (export "plugin_free") (param $p i32) (param $n i32)
            (global.set $bump (local.get $p)))
          (func $blit (param $src i32) (param $len i32) (param $out i32) (param $cap i32) (result i64)
            (local $i i32)
            (if (i32.lt_s (local.get $cap) (local.get $len))
              (then (return (i64.extend_i32_s (i32.sub (i32.const 0) (local.get $len))))))
            (block $done (loop $loop
              (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
              (i32.store8 (i32.add (local.get $out) (local.get $i))
                (i32.load8_u (i32.add (local.get $src) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $loop)))
            (i64.extend_i32_s (local.get $len)))
          (func (export "plugin_describe") (param $out i32) (param $cap i32) (result i64)
            (call $blit (i32.const {decl_off}) (i32.const {dlen}) (local.get $out) (local.get $cap)))
          (func (export "plugin_invoke") (param i32 i32 i32 i32) (param $out i32) (param $cap i32) (result i64)
            (call $log (i32.const 1) (i32.const {msg_off}) (i32.const {mlen}))
            (call $blit (i32.const {res_off}) (i32.const {rlen}) (local.get $out) (local.get $cap)))
        )"#,
        msg_off = msg_off,
        decl_off = decl_off,
        res_off = res_off,
        msg = msg,
        decl = decl,
        reply = reply,
        mlen = msg.len(),
        dlen = decl.len(),
        rlen = reply.len(),
    );
    wat::parse_str(&wat).expect("test WAT must assemble")
}

#[test]
fn calls_into_one_slot_are_never_concurrent() {
    // THE ABI CONTRACT. Eight threads, one slot. If a single instance were ever
    // entered while already running, hook entries would nest and `peak` would
    // exceed 1.
    let dir = tmpdir("per-instance");
    let a = write_wasm(&dir, "a", &wasm_that_logs_on_invoke("a"));

    let peak = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(AtomicUsize::new(0));
    let host = Arc::new(observing_host(peak.clone(), seen.clone()));
    host.load("a", &a, serde_json::Value::Null).unwrap();

    let mut handles = Vec::new();
    for _ in 0..8 {
        let host = host.clone();
        handles.push(std::thread::spawn(move || {
            for _ in 0..8 {
                host.call_tool("a_tool", &serde_json::json!({})).unwrap();
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }

    assert!(
        seen.load(Ordering::SeqCst) >= 64,
        "the hook must have seen every guest call (saw {})",
        seen.load(Ordering::SeqCst)
    );
    assert_eq!(
        peak.load(Ordering::SeqCst),
        1,
        "one plugin instance was entered while already running. Plugins keep \
         mutable globals (see plugins/hello-rust's `static mut CACHED`) and the \
         ABI now states this guarantee — see 'Threading' in docs/ABI.md. If \
         concurrency was widened deliberately, that section and those plugins \
         must change with it."
    );
}

#[test]
fn wasm_host_serialises_even_across_slots() {
    // THE WasmHost LAYER, which is *stronger* than the ABI requires. Two slots,
    // four threads. Serialisation here is why the studio's tool calls cannot
    // interleave — and why a slow tool in one slot delays the others, which
    // docs/已知问题.md tracks.
    //
    // `Registry::call_many_parallel` deliberately does NOT do this: it runs one
    // thread per slot. So if this test ever changes, only WasmHost changed — not
    // the ABI — and the fix belongs in WasmHost.
    let dir = tmpdir("cross-slot");
    let a = write_wasm(&dir, "a", &wasm_that_logs_on_invoke("a"));
    let b = write_wasm(&dir, "b", &wasm_that_logs_on_invoke("b"));

    let peak = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(AtomicUsize::new(0));
    let host = Arc::new(observing_host(peak.clone(), seen.clone()));
    host.load("a", &a, serde_json::Value::Null).unwrap();
    host.load("b", &b, serde_json::Value::Null).unwrap();

    let mut handles = Vec::new();
    for i in 0..4 {
        let host = host.clone();
        handles.push(std::thread::spawn(move || {
            let tool = if i % 2 == 0 { "a_tool" } else { "b_tool" };
            for _ in 0..8 {
                host.call_tool(tool, &serde_json::json!({})).unwrap();
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }

    assert!(seen.load(Ordering::SeqCst) >= 32, "hook saw too few calls");
    assert_eq!(
        peak.load(Ordering::SeqCst),
        1,
        "WasmHost allowed two slots to run at once. That is not an ABI \
         violation (see call_many_parallel), but WasmHost is documented as \
         serialising globally — if that changed, the studio's assumptions and \
         docs/ABI.md need updating too."
    );
}

#[test]
fn the_log_hook_runs_while_the_registry_lock_is_held() {
    // This pins the *cause* of a real limitation, and is deliberately written to
    // observe it rather than trip over it.
    //
    // `WasmHost::call_tool` holds the registry mutex for the whole guest call —
    // that is what makes the serialisation above sound. A guest's `host.log`
    // fires the hook *inside* that call, so the hook runs with the mutex held.
    // A hook that calls back into `WasmHost` (e.g. `host.list_plugins()`)
    // therefore self-deadlocks: same non-reentrant `Mutex`.
    //
    // So the constraint is "a LogHook must not call back into WasmHost". That is
    // written down in `docs/ABI.md` and `docs/已知问题.md`; this test is what
    // stops it from being rediscovered the hard way. It asserts the lock is held
    // (a deterministic, instant observation) rather than actually deadlocking
    // (a hang, which would be a terrible test).
    let dir = tmpdir("hook-under-lock");
    let a = write_wasm(&dir, "a", &wasm_that_logs_on_invoke("a"));

    let held: Arc<Mutex<Option<bool>>> = Arc::new(Mutex::new(None));
    let held_for_hook = held.clone();
    let slot: Arc<Mutex<Option<WasmHost>>> = Arc::new(Mutex::new(None));
    let slot_for_hook = slot.clone();

    let hook: LogHook = Arc::new(move |_rec| {
        if let Some(h) = slot_for_hook.lock().unwrap().as_ref() {
            // `try_lock` must FAIL: the calling thread already owns it.
            let could_take = h.registry().try_lock().is_ok();
            *held_for_hook.lock().unwrap() = Some(could_take);
        }
    });

    let host = WasmHost::with_options(HostOptions {
        log_hook: Some(hook),
        ..Default::default()
    })
    .expect("host builds");
    host.load("a", &a, serde_json::Value::Null).unwrap();
    *slot.lock().unwrap() = Some(host.clone());

    host.call_tool("a_tool", &serde_json::json!({})).unwrap();

    let observed = held.lock().unwrap().expect("the hook must have run");
    assert!(
        !observed,
        "the hook took the registry lock, so it was called OUTSIDE it — the \
         serialisation contract has changed. If that was deliberate, a LogHook \
         may now re-enter WasmHost, and this test (plus the 'must not call back' \
         note in docs/ABI.md) should be updated to say so."
    );
}

#[test]
fn the_registry_layer_may_run_slots_in_parallel_but_never_one_instance_twice() {
    // The ABI floor, checked at the *Registry* layer rather than through
    // `WasmHost`. This is the test that justifies the doc's careful wording:
    // `call_many_parallel` really does run different slots concurrently, so a
    // blanket claim that "the host serialises everything" would be false — while
    // the per-instance guarantee still has to hold.
    //
    // Two observations in one run:
    //   * cross-slot overlap DOES happen (so the concurrency is real), and
    //   * no two entries are ever inside the *same* slot at once.
    use std::collections::HashMap;
    use wasm_plugin_host::{Registry, Runtime};

    let dir = tmpdir("registry-parallel");
    let a = write_wasm(&dir, "a", &wasm_that_logs_on_invoke("a"));
    let b = write_wasm(&dir, "b", &wasm_that_logs_on_invoke("b"));

    // Per-slot nesting depth, and the global peak: if one instance is never
    // re-entered, each slot's depth must never exceed 1.
    let depth: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    let peak_any: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
    let live = Arc::new(AtomicUsize::new(0));
    let d2 = depth.clone();
    let pk2 = peak_any.clone();
    let lv2 = live.clone();

    let hook: LogHook = Arc::new(move |rec| {
        let global = lv2.fetch_add(1, Ordering::SeqCst) + 1;
        pk2.fetch_max(global, Ordering::SeqCst);
        let mut d = d2.lock().unwrap();
        let slot_depth = d.entry(rec.slot.clone()).or_insert(0);
        *slot_depth += 1;
        let exceeded = *slot_depth > 1;
        drop(d);
        std::thread::sleep(Duration::from_millis(5));
        let mut d = d2.lock().unwrap();
        *d.get_mut(&rec.slot).unwrap() -= 1;
        drop(d);
        lv2.fetch_sub(1, Ordering::SeqCst);
        assert!(
            !exceeded,
            "slot `{}` was entered while already running — the per-instance ABI \
             guarantee is broken",
            rec.slot
        );
    });

    let rt = Runtime::new().unwrap();
    let mut reg = Registry::with_logging(rt, 1000, false, Some(hook));
    reg.load("a", &a, serde_json::Value::Null).unwrap();
    reg.load("b", &b, serde_json::Value::Null).unwrap();

    // Interleaved across the two slots, which is what makes them run in parallel.
    let calls: Vec<(&str, serde_json::Value)> = (0..16)
        .map(|i| {
            if i % 2 == 0 {
                ("a_tool", serde_json::json!({}))
            } else {
                ("b_tool", serde_json::json!({}))
            }
        })
        .collect();
    let out = reg.call_many_parallel(&calls);
    assert!(out.iter().all(|r| r.is_ok()), "all calls should succeed: {out:?}");

    assert!(
        peak_any.load(Ordering::SeqCst) > 1,
        "call_many_parallel ran everything serially (peak {}), so this test would \
         not have caught a same-instance overlap either",
        peak_any.load(Ordering::SeqCst)
    );
}
