use anyhow::{Context, Result};
use std::path::Path;
use wasm_plugin_host::{PluginPolicy, Registry, Runtime, TrustMode};

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let path = args.next().context(
        "usage: cargo run -p wasm-plugin-host --example component_smoke -- <component.wasm> [tool-name] [sandboxed]",
    )?;
    let tool = args.next().unwrap_or_else(|| "component_echo".to_string());
    let sandboxed = matches!(args.next().as_deref(), Some("sandboxed"));

    let runtime = Runtime::new()?;
    let mut registry = Registry::new(runtime);
    let config = serde_json::json!({"source":"component-smoke"});
    let report = if sandboxed {
        registry.load_with_policy(
            "component-smoke",
            Path::new(&path),
            config,
            PluginPolicy {
                trust: TrustMode::Sandboxed,
                ..Default::default()
            },
        )?
    } else {
        registry.load("component-smoke", Path::new(&path), config)?
    };

    println!(
        "loaded slot={} plugin={} tools={:?}",
        report.slot, report.plugin, report.tools
    );

    let result = registry.call_tool(&tool, &serde_json::json!({"hello":"component","n":42}))?;
    println!("{}", serde_json::to_string_pretty(&result)?);

    registry.unload("component-smoke")?;
    println!("unloaded component-smoke");
    Ok(())
}
