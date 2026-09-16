//! Compose a WASM plugin host with a dsh-rs agent harness and run one turn.
//!
//! Run with:
//!
//! ```sh
//! cargo run -p dsh-wasm-host --example compose
//! ```
//!
//! It boots dsh's base bundle, loads the `hello-rust` example plugin (built
//! for wasm32-wasip1), registers its tools on `ctx.tools`, then runs a turn in
//! which the mock model calls the plugin's `greet` tool. Because the mock
//! adapter echoes, the exact model text is unimportant — what matters is that
//! the tool call is dispatched into the WASM guest and its result is logged to
//! the session.
//!
//! Build the plugin first:
//!
//! ```sh
//! cargo build --release -p hello-rust --target wasm32-wasip1
//! ```

use dsh_rs::api::services::{AgentRegistryService, LlmService, ToolsService};
use dsh_rs::types::{AgentOptions, ContentBlock, Message, SessionEventData};
use dsh_wasm_host::{install, LoadSpec, WasmHost};
use serde_json::json;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    // 1. Boot the harness: sessions, tools, llm seam, agent loop.
    let ctx = cordis::Context::new();
    dsh_rs::bundle::install_base_default(&ctx)
        .await
        .map_err(anyhow::Error::msg)?;

    // 2. Point the mock provider at a scripted turn that calls a wasm tool.
    let runtime = ctx.require::<LlmService>(dsh_rs::api::LLM_SERVICE)?;
    runtime.unregister_adapter(&["mock"]);
    runtime.register_adapter(
        &["mock"],
        std::sync::Arc::new(dsh_rs::llm::adapters::mock::MockAdapter::scripted(vec![
            dsh_rs::llm::adapters::mock::MockAdapter::tool_call_response(
                "call-1",
                "greet",
                json!({ "who": "wasm" }),
            ),
            dsh_rs::llm::adapters::mock::MockAdapter::text_response("greeted"),
        ])),
    )
    .map_err(anyhow::Error::msg)?;

    // 3. Mount the wasm host: load a plugin and bridge its tools + flow hooks.
    let plugin_path = std::env::var("WASM_PLUGIN").unwrap_or_else(|_| {
        "target/wasm32-wasip1/release/hello_rust.wasm".to_string()
    });
    if !std::path::Path::new(&plugin_path).exists() {
        eprintln!(
            "plugin not found at {plugin_path}\n\
             build it with: cargo build --release -p hello-rust --target wasm32-wasip1"
        );
        return Ok(());
    }

    let host = WasmHost::new()?;
    install(
        &ctx,
        host.clone(),
        vec![LoadSpec::new("hello", plugin_path)],
    )
    .await?;

    // 4. Show what the bridge registered.
    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE)?;
    println!("tools on ctx.tools: {:?}", tools.list());

    // 5. Drive one agent turn.
    let agents = ctx.require::<AgentRegistryService>(dsh_rs::api::AGENTS_SERVICE)?;
    let agent = agents
        .create(
            None,
            AgentOptions::mock("mock-1"),
            Some("/tmp".to_string()),
            None,
        )
        .map_err(anyhow::Error::msg)?;
    agent.followup(Message::user(
        "u-1",
        vec![ContentBlock::text("please greet wasm")],
    ));
    agent.when_idle().await;

    // 6. Report the tool result the wasm guest produced.
    for event in agent.session().events() {
        if let SessionEventData::ToolResult { message, .. } = &event.data {
            let mut text = String::new();
            for block in &message.content {
                if let ContentBlock::ToolResult { content, .. } = block {
                    for inner in content {
                        if let ContentBlock::Text { text: t } = inner {
                            text.push_str(t);
                        }
                    }
                }
            }
            println!("wasm tool result: {text}");
        }
    }

    // 7. Show the guest's captured logs (language-agnostic WASI stdout).
    //    `render()` already includes the `[slot]` prefix.
    for record in host.logs() {
        println!("{}", record.render());
    }

    Ok(())
}
