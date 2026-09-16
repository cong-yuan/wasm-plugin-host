//! Demonstrate: calls to *different* plugins run in parallel; calls to the
//! *same* plugin are serialized. Also shows the pooling allocator.
use wasm_plugin_host::{AllocationStrategy, Registry, Runtime};

fn main() -> anyhow::Result<()> {
    let rt = Runtime::with_strategy(AllocationStrategy::pooled_default())?;
    println!("strategy: {}", rt.strategy_name());
    let mut reg = Registry::with_logging(rt, 1000, false, None);

    let rust = "target/wasm32-wasip1/release/hello_rust.wasm";
    let go = "/tmp/plainlog/plainlog.wasm";
    reg.load("r", std::path::Path::new(rust), serde_json::Value::Null)?;
    reg.load("g", std::path::Path::new(go), serde_json::Value::Null)?;

    // 200 calls across two plugins.
    let calls: Vec<(&str, serde_json::Value)> = (0..200)
        .map(|i| {
            if i % 2 == 0 {
                ("greet", serde_json::json!({"who": format!("u{i}")}))
            } else {
                ("echo_num", serde_json::json!({"n": i}))
            }
        })
        .collect();

    let t = std::time::Instant::now();
    let out = reg.call_many_parallel(&calls);
    let el = t.elapsed();
    let ok = out.iter().filter(|r| r.is_ok()).count();
    println!("200 parallel calls in {el:?} ({ok} ok)", );
    println!("sample: {:?}", out[0].as_ref().map(|v| v["kind"].clone()));
    Ok(())
}
