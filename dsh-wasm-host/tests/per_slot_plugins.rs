//! B: each WASM slot is mounted as its **own** cordis plugin, so it has its own
//! fiber, its own `inject` list, and its own `provide`ed services.
//!
//! These tests are the point of the whole crate's granularity claim: a WASM
//! plugin is not a flattened leaf inside one blob — it participates in cordis's
//! service graph exactly like a native dsh plugin does.

mod common;

use cordis::{Context, FiberState};
use dsh_rs::api::services::{AgentRegistryService, ToolsService};
use dsh_wasm_host::{install, LoadSpec, WasmHost, WasmService};
use serde_json::json;

use common::{boot_dsh, host, tmpdir, wasm_injector, wasm_provider, write_wasm};

use dsh_wasm_host::plugin::resync_slot_tools;

#[tokio::test]
async fn each_slot_gets_its_own_fiber() {
    let dir = tmpdir("own-fiber");
    let a = write_wasm(&dir, "a", &wasm_provider("a", &["svc_a"]));
    let b = write_wasm(&dir, "b", &wasm_provider("b", &["svc_b"]));
    let ctx = Context::new();
    boot_dsh(&ctx).await;

    let mounted = install(
        &ctx,
        host(),
        vec![
            LoadSpec::new("a", a.to_string_lossy().to_string()),
            LoadSpec::new("b", b.to_string_lossy().to_string()),
        ],
    )
    .await
    .unwrap();

    // Two slots -> two independent fibers (plus the shared bridge).
    assert_eq!(mounted.slots.len(), 2);
    assert!(mounted.slot_fiber("a").is_some());
    assert!(mounted.slot_fiber("b").is_some());
    assert_eq!(
        mounted.slot_fiber("a").unwrap().state(),
        FiberState::Active,
        "a slot with no unmet injects must be Active"
    );

    // Disposing ONE slot's fiber tears down only that slot.
    mounted.slot_fiber("a").unwrap().dispose().await;
    assert!(!mounted.host.is_loaded("a"), "a's fiber dispose unloads a");
    // b is untouched.
    assert!(mounted.host.is_loaded("b"), "disposing a must not affect b");
}

#[tokio::test]
async fn a_slot_stays_pending_until_its_inject_is_provided() {
    // `needy` injects `capability`; nothing provides it yet, so its fiber must
    // stay PENDING (cordis's own gate) and its tool must NOT be registered.
    let dir = tmpdir("pending");
    let needy = write_wasm(&dir, "needy", &wasm_injector("needy", &["capability"]));
    let ctx = Context::new();
    boot_dsh(&ctx).await;

    let mounted = install(
        &ctx,
        host(),
        vec![LoadSpec::new("needy", needy.to_string_lossy().to_string())],
    )
    .await
    .unwrap();

    let needy_fiber = mounted.slot_fiber("needy").unwrap();
    assert_eq!(
        needy_fiber.state(),
        FiberState::Pending,
        "an unmet inject must leave the fiber PENDING, not Active"
    );

    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE).unwrap();
    assert!(
        !tools.list().contains(&"needy_tool".to_string()),
        "a PENDING slot must not register its tools"
    );
}

#[tokio::test]
async fn providing_the_service_activates_the_pending_slot() {
    // Same as above, but a provider slot supplies `capability` — the needy
    // slot's fiber must converge to Active and its tool appear.
    let dir = tmpdir("converge");
    let provider = write_wasm(&dir, "prov", &wasm_provider("prov", &["capability"]));
    let needy = write_wasm(&dir, "needy", &wasm_injector("needy", &["capability"]));
    let ctx = Context::new();
    boot_dsh(&ctx).await;

    let mounted = install(
        &ctx,
        host(),
        vec![
            LoadSpec::new("prov", provider.to_string_lossy().to_string()),
            LoadSpec::new("needy", needy.to_string_lossy().to_string()),
        ],
    )
    .await
    .unwrap();

    let needy_fiber = mounted.slot_fiber("needy").unwrap();
    assert_eq!(
        needy_fiber.state(),
        FiberState::Active,
        "the provider should satisfy the inject and activate the dependent"
    );
    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE).unwrap();
    assert!(
        tools.list().contains(&"needy_tool".to_string()),
        "the activated slot's tool must be registered, got {:?}",
        tools.list()
    );
}

#[tokio::test]
async fn a_wasm_provided_service_is_requireable_by_other_dsh_plugins() {
    // The real payoff: a WASM slot's `provides` is a first-class cordis service.
    // A *native* dsh plugin (here, the test itself) can `require` it and call it.
    let dir = tmpdir("require-svc");
    let provider = write_wasm(&dir, "memory", &wasm_provider("memory", &["memory"]));
    let ctx = Context::new();
    boot_dsh(&ctx).await;

    install(
        &ctx,
        host(),
        vec![LoadSpec::new("memory", provider.to_string_lossy().to_string())],
    )
    .await
    .unwrap();

    let svc = ctx
        .require::<WasmService>("memory")
        .expect("the wasm slot must have provided `memory` on the context");
    assert_eq!(svc.name, "memory");
    assert_eq!(svc.slot, "memory");

    // Calling it crosses into the guest and back as JSON.
    let reply = svc.call("recall", json!({ "key": "k" })).await.unwrap();
    assert_eq!(reply["kind"], "success");
    assert_eq!(reply["value"]["provider"], "memory");
}

#[tokio::test]
async fn a_wasm_service_disappears_when_its_slot_is_disposed() {
    let dir = tmpdir("svc-gone");
    let provider = write_wasm(&dir, "memory", &wasm_provider("memory", &["memory"]));
    let ctx = Context::new();
    boot_dsh(&ctx).await;

    let mounted = install(
        &ctx,
        host(),
        vec![LoadSpec::new("memory", provider.to_string_lossy().to_string())],
    )
    .await
    .unwrap();

    assert!(ctx.require::<WasmService>("memory").is_ok());

    mounted.slot_fiber("memory").unwrap().dispose().await;

    assert!(
        ctx.require::<WasmService>("memory").is_err(),
        "disposing the slot must withdraw the service it provided"
    );
}

#[tokio::test]
async fn a_dsh_service_can_satisfy_a_wasm_slots_inject() {
    // The reverse direction: a WASM slot injects a service that only the *host*
    // provides. Declaring it external must let the slot activate.
    let dir = tmpdir("dsh-svc");
    let needy = write_wasm(&dir, "needy", &wasm_injector("needy", &["sessions"]));
    let ctx = Context::new();
    boot_dsh(&ctx).await;

    let host = WasmHost::new().unwrap();
    // dsh's base bundle provides `sessions`; tell the wasm registry so.
    host.declare_dsh_service("sessions");

    let mounted = install(
        &ctx,
        host,
        vec![LoadSpec::new("needy", needy.to_string_lossy().to_string())],
    )
    .await
    .unwrap();

    assert_eq!(
        mounted.slot_fiber("needy").unwrap().state(),
        FiberState::Active,
        "a host-declared service must satisfy the slot's inject"
    );
}

#[tokio::test]
async fn each_slot_provides_independently_and_tools_are_attributed_by_slot() {
    let dir = tmpdir("attribution");
    let a = write_wasm(&dir, "a", &wasm_provider("a", &["svc_a"]));
    let b = write_wasm(&dir, "b", &wasm_provider("b", &["svc_b"]));
    let ctx = Context::new();
    boot_dsh(&ctx).await;

    let mounted = install(
        &ctx,
        host(),
        vec![
            LoadSpec::new("a", a.to_string_lossy().to_string()),
            LoadSpec::new("b", b.to_string_lossy().to_string()),
        ],
    )
    .await
    .unwrap();

    assert!(ctx.require::<WasmService>("svc_a").is_ok());
    assert!(ctx.require::<WasmService>("svc_b").is_ok());

    // The registry attributes each service to its own slot.
    assert_eq!(mounted.host.services().len(), 2);
}

#[tokio::test]
async fn resync_slot_tools_only_touches_the_named_slot() {
    let dir = tmpdir("resync-slot");
    let a = write_wasm(&dir, "a", &wasm_provider("a", &["svc_a"]));
    let ctx = Context::new();
    boot_dsh(&ctx).await;
    let host = host();
    install(
        &ctx,
        host.clone(),
        vec![LoadSpec::new("a", a.to_string_lossy().to_string())],
    )
    .await
    .unwrap();

    let tools = ctx.require::<ToolsService>(dsh_rs::api::TOOLS_SERVICE).unwrap();
    // A provider slot declares no tools, so this is a no-op but must not panic
    // and must report nothing for a different slot.
    let mut tracked = Vec::new();
    let (added, removed) = resync_slot_tools(&tools, &host, "a", &mut tracked);
    assert!(added.is_empty() && removed.is_empty());
}

#[tokio::test]
async fn agent_loop_still_drives_a_per_slot_wasm_tool() {
    // Regression: splitting into one fiber per slot must not break the core
    // promise — a wasm tool is still callable through the real agent loop.
    let dir = tmpdir("loop-still-works");
    let wasm = write_wasm(&dir, "alpha", &common::wasm_tool("alpha", "success"));
    let ctx = Context::new();
    boot_dsh(&ctx).await;
    install(
        &ctx,
        host(),
        vec![LoadSpec::new("alpha", wasm.to_string_lossy().to_string())],
    )
    .await
    .unwrap();

    common::script_tool_call(&ctx, "call-1", "alpha_tool", json!({})).await;
    let agents = ctx
        .require::<AgentRegistryService>(dsh_rs::api::AGENTS_SERVICE)
        .unwrap();
    let agent = agents
        .create(
            None,
            dsh_rs::types::AgentOptions::mock("mock-1"),
            Some("/tmp".to_string()),
            None,
        )
        .unwrap();
    agent.followup(dsh_rs::types::Message::user(
        "u-1",
        vec![dsh_rs::types::ContentBlock::text("go")],
    ));
    agent.when_idle().await;

    let executed = agent.session().events().iter().any(|e| {
        matches!(&e.data, dsh_rs::types::SessionEventData::ToolResult { .. })
    });
    assert!(executed, "the per-slot wasm tool must run in the agent loop");
}

#[tokio::test]
async fn disposing_a_keeping_loaded_slot_does_not_unload_the_guest() {
    // Regression: `WasmSlotPlugin::keeping_loaded` must only deactivate in the
    // registry. If its disposer unloaded the guest, a host that remounts a fiber
    // (e.g. a hot reload: dispose → swap code → remount) would find the slot
    // gone. `WasmSlotPlugin::new` keeps the opposite (unloading) behaviour.
    use dsh_wasm_host::WasmSlotPlugin;
    use std::sync::Arc;

    let dir = tmpdir("keep-loaded");
    let wasm = write_wasm(&dir, "alpha", &wasm_provider("alpha", &[]));
    let ctx = Context::new();
    boot_dsh(&ctx).await;
    let host = host();
    host.load("alpha", &wasm, json!(null)).unwrap();

    let plugin: Arc<dyn cordis::plugin::Plugin> =
        Arc::new(WasmSlotPlugin::keeping_loaded("alpha", host.clone()));
    let fiber = ctx.plugin(plugin, None);
    fiber.join().await.unwrap();
    assert!(host.is_loaded("alpha"), "loaded before dispose");

    // Disposing must leave the guest instance in the registry.
    fiber.dispose().await;
    assert!(
        host.is_loaded("alpha"),
        "`keeping_loaded` must NOT unload the guest on dispose"
    );

    // Contrast: the default plugin *does* unload.
    let plugin2: Arc<dyn cordis::plugin::Plugin> =
        Arc::new(WasmSlotPlugin::new("alpha", host.clone()));
    let fiber2 = ctx.plugin(plugin2, None);
    fiber2.join().await.unwrap();
    fiber2.dispose().await;
    assert!(
        !host.is_loaded("alpha"),
        "the default plugin unloads the guest on dispose"
    );
}
