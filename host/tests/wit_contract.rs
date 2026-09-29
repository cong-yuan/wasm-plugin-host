//! Compile-time validation for the Component Model contracts.
//!
//! WIT 0.1 / 0.2 remain loadable runtime contracts while newer wire revisions
//! evolve in parallel; every version must stay independently bindable.

mod v1 {
    wasmtime::component::bindgen!({
        path: "../wit",
        world: "plugin",
    });
}

mod v2 {
    wasmtime::component::bindgen!({
        path: "../wit-v0.2",
        world: "plugin",
    });
}

mod v3 {
    wasmtime::component::bindgen!({
        path: "../wit-v0.3",
        world: "plugin",
    });
}

mod v4 {
    wasmtime::component::bindgen!({
        path: "../wit-v0.4",
        world: "plugin",
    });
}

#[test]
fn wit_v01_contract_generates_component_bindings() {
    let _ = std::any::type_name::<v1::Plugin>();
}

#[test]
fn wit_v02_contract_generates_component_bindings_with_tool_dependencies() {
    let _ = std::any::type_name::<v2::Plugin>();

    let tool = v2::wasm_plugin_host::plugin::types::ToolDecl {
        name: "summarize".into(),
        description: "Summarize a fetched document".into(),
        parameters_json: r#"{"type":"object"}"#.into(),
        exec: "summarize".into(),
        requires: vec!["fetch_document".into()],
    };
    assert_eq!(tool.requires, vec!["fetch_document"]);
}

#[test]
fn wit_v03_contract_generates_typed_ui_declarations() {
    let _ = std::any::type_name::<v3::Plugin>();

    let ui = v3::wasm_plugin_host::plugin::types::UiDecl {
        provides: vec![v3::wasm_plugin_host::plugin::types::SlotDecl {
            name: "demo.slot".into(),
            description: Some("typed slot".into()),
        }],
        injects: vec![v3::wasm_plugin_host::plugin::types::SlotInject {
            slot: "host.main".into(),
            priority: 10,
            component: Some("DemoPanel".into()),
        }],
        assets: vec![v3::wasm_plugin_host::plugin::types::UiAsset {
            name: "entry.js".into(),
            source: "export const demo = true;".into(),
        }],
        windows: vec![v3::wasm_plugin_host::plugin::types::WindowDecl {
            name: "main".into(),
            component: "DemoPanel".into(),
            title: Some("Demo".into()),
            width: Some(800.0),
            height: Some(600.0),
            open: v3::wasm_plugin_host::plugin::types::WindowOpen::Manual,
            content: v3::wasm_plugin_host::plugin::types::WindowContent::App,
            html: None,
        }],
        routes: vec![v3::wasm_plugin_host::plugin::types::RouteDecl {
            path: "demo".into(),
            component: "DemoPanel".into(),
            title: Some("Demo".into()),
            icon: None,
            nav: true,
        }],
        adjusts: vec![v3::wasm_plugin_host::plugin::types::UiAdjust {
            slot: "host.*".into(),
            from_plugin: None,
            action: v3::wasm_plugin_host::plugin::types::AdjustAction::Priority,
            to: Some(5),
            by: None,
            component: None,
        }],
    };
    assert_eq!(ui.provides[0].name, "demo.slot");
}

#[test]
fn wit_v04_contract_generates_typed_hook_decisions() {
    let _ = std::any::type_name::<v4::Plugin>();
    use v4::wasm_plugin_host::plugin::types::HookDecision;

    let decisions = [
        HookDecision::Continue,
        HookDecision::Rewrite(r#"{\"x\":1}"#.into()),
        HookDecision::Veto("blocked".into()),
    ];
    assert!(matches!(decisions[0], HookDecision::Continue));
    assert!(matches!(decisions[1], HookDecision::Rewrite(_)));
    assert!(matches!(decisions[2], HookDecision::Veto(_)));
}
