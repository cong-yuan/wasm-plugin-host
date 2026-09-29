//! Compile-time validation for the Component Model contracts.
//!
//! WIT 0.1 remains the live runtime contract. WIT 0.2 evolves the wire shape
//! in parallel; both must stay syntactically valid and independently bindable.

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
