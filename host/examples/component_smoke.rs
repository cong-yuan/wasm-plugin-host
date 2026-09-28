use anyhow::{Context, Result};
use std::path::Path;
use wasm_plugin_host::{Registry, Runtime};

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().context(
        "usage: cargo run -p wasm-plugin-host --example component_smoke -- <component.wasm> [tool-name]",
    )?;
    let tool = args.next().unwrap_or_else(|| "component_echo".to_string());

    let runtime = Runtime::new()?;
    let mut registry = Registry::new(runtime);
    let report = registry.load(
        "component-smoke",
        Path::new(&path),
        serde_json::json!({"source":"component-smoke"}),
    )?;

    println!(
        "loaded slot={} plugin={} tools={:?}",
        report.slot, report.plugin, report.tools
    );

    let result = registry.call_tool(
        &tool,
        &serde_json::json!({"hello":"component","n":42}),
    )?;
    println!("{}", serde_json::to_string_pretty(&result)?);

    registry.unload("component-smoke")?;
    println!("unloaded component-smoke");
    Ok(())
}
