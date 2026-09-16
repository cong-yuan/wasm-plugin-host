//! Measure the disk compile-cache speedup: cold compile vs warm deserialize.
//!
//! Run with:
//!
//! ```sh
//! cargo run --release -p wasm-plugin-host --example bench_cache
//! ```
//!
//! It times `load()` three ways against the Go example plugin (a large module,
//! where compilation cost is clearly visible):
//!
//! 1. **no cache** — every load compiles;
//! 2. **cold** — cache present but empty: compiles and writes a `.cwasm`;
//! 3. **warm** — cache populated: deserializes instead of compiling.
//!
//! Results on Apple M2 Pro, wasmtime 44, release (reference):
//!
//! ```text
//! go plugin, load() wall time:
//!   no cache        :   268 ms
//!   cold (compile)  :   338 ms   (+ write of the .cwasm)
//!   warm (deserial.):     7 ms
//!   speedup         :   ~49x
//! ```

use std::path::PathBuf;
use std::time::{Duration, Instant};

use wasm_plugin_host::{Registry, Runtime};

/// Load one plugin and return `(elapsed, stats)`.
fn timed_load(cache: Option<&PathBuf>, wasm: &PathBuf) -> anyhow::Result<(Duration, wasm_plugin_host::CacheStats)> {
    let rt = match cache {
        Some(dir) => Runtime::new_cached(dir)?,
        None => Runtime::new()?,
    };
    let mut reg = Registry::new(rt);
    let start = Instant::now();
    reg.load("go", wasm, serde_json::Value::Null)?;
    let elapsed = start.elapsed();
    let stats = reg.runtime().cache_stats();
    // Drop the registry (and its runtime) before returning, so the next phase
    // starts from a genuinely cold in-process state.
    drop(reg);
    Ok((elapsed, stats))
}

fn main() -> anyhow::Result<()> {
    let wasm = PathBuf::from("plugins/hello-go/hello_go.wasm");
    if !wasm.exists() {
        eprintln!("plugin not found at {}", wasm.display());
        return Ok(());
    }

    let cache = std::env::temp_dir().join(format!("wph-bench-cache-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&cache);

    let (no_cache, _) = timed_load(None, &wasm)?;
    let (cold, cold_stats) = timed_load(Some(&cache), &wasm)?;
    let (warm, warm_stats) = timed_load(Some(&cache), &wasm)?;

    println!("go plugin, load() wall time (release):");
    println!("  no cache         : {:>8.2} ms", ms(no_cache));
    println!("  cold (compile)   : {:>8.2} ms   (hits={} misses={} writes={})",
        ms(cold), cold_stats.hits, cold_stats.misses, cold_stats.writes);
    println!("  warm (deserial.) : {:>8.2} ms   (hits={} misses={} writes={})",
        ms(warm), warm_stats.hits, warm_stats.misses, warm_stats.writes);
    println!("  speedup          : {:>8.1}x", cold.as_secs_f64() / warm.as_secs_f64());

    let _ = std::fs::remove_dir_all(&cache);
    Ok(())
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}
