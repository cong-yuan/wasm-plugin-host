use anyhow::{Context, Result};
use std::path::Path;
use wasm_plugin_host::{
    AgentCapabilities, CapabilitySet, FlowEvent, PluginPolicy, Registry, Runtime, TrustMode,
};

fn main() -> Result<()> {
    let path = std::env::args().nth(1).context(
        "usage: cargo run -p wasm-plugin-host --example component_hook_smoke -- <component.wasm>",
    )?;

    let runtime = Runtime::new()?;
    let mut registry = Registry::new(runtime);
    let report = registry.load_with_policy(
        "typed-hook",
        Path::new(&path),
        serde_json::json!({"source":"component-hook-smoke"}),
        PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                agent: AgentCapabilities {
                    rewrite: vec!["tools/pre-execute".into()],
                    veto: vec!["tools/pre-execute".into()],
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        },
    )?;

    println!(
        "loaded slot={} plugin={} hooks={:?}",
        report.slot, report.plugin, report.hooks
    );

    let dispatch = registry.dispatch(
        FlowEvent::ToolsPreExecute,
        serde_json::json!({
            "name": "typed_hook_echo",
            "args": {"hello":"hook"}
        }),
    );

    anyhow::ensure!(
        dispatch.vetoed_by.as_deref() == Some("typed-hook"),
        "expected typed-hook veto, got {:?}",
        dispatch.vetoed_by
    );
    anyhow::ensure!(
        dispatch.veto_reason.as_deref() == Some("blocked by WIT 0.4 typed hook"),
        "unexpected veto reason: {:?}",
        dispatch.veto_reason
    );
    println!(
        "typed hook vetoed by {:?}: {:?}",
        dispatch.vetoed_by, dispatch.veto_reason
    );

    registry.unload("typed-hook")?;
    Ok(())
}
