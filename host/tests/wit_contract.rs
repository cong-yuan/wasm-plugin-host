//! Compile-time validation for the Phase E Component Model contract.
//!
//! If the WIT package becomes syntactically invalid or the named world
//! disappears, this test crate stops compiling.

wasmtime::component::bindgen!({
    path: "../wit",
    world: "plugin",
});

#[test]
fn wit_contract_generates_component_bindings() {
    // The generated world type is enough evidence that Wasmtime parsed the WIT
    // package and generated bindings for the selected world.
    let _ = std::any::type_name::<Plugin>();
}
