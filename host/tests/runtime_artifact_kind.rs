use std::path::PathBuf;
use wasm_plugin_host::{CompiledArtifact, Registry, Runtime, WasmArtifactKind};

fn tmpdir(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "wasm-plugin-runtime-artifact-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

#[test]
fn runtime_distinguishes_core_modules_from_components() {
    let dir = tmpdir("kinds");
    let core = dir.join("core.wasm");
    let component = dir.join("component.wasm");

    std::fs::write(&core, wat::parse_str("(module)").unwrap()).unwrap();
    std::fs::write(&component, wat::parse_str("(component)").unwrap()).unwrap();

    assert_eq!(
        Runtime::artifact_kind(&core).unwrap(),
        WasmArtifactKind::CoreModule
    );
    assert_eq!(
        Runtime::artifact_kind(&component).unwrap(),
        WasmArtifactKind::Component
    );

    let runtime = Runtime::new().unwrap();
    assert!(matches!(
        runtime.compile_artifact(runtime.engine(), &core).unwrap(),
        CompiledArtifact::CoreModule(_)
    ));
    assert!(matches!(
        runtime.compile_artifact(runtime.engine(), &component).unwrap(),
        CompiledArtifact::Component(_)
    ));
}

#[test]
fn runtime_compiles_and_caches_a_component_artifact() {
    let dir = tmpdir("component-compile");
    let component = dir.join("component.wasm");
    std::fs::write(&component, wat::parse_str("(component)").unwrap()).unwrap();

    let runtime = Runtime::new().unwrap();
    runtime
        .compile_component(runtime.engine(), &component)
        .expect("empty component should compile");
    runtime
        .compile_component(runtime.engine(), &component)
        .expect("second compile should hit the in-process component cache");
}

#[test]
fn core_module_is_not_accepted_by_component_compiler() {
    let dir = tmpdir("wrong-backend");
    let core = dir.join("core.wasm");
    std::fs::write(&core, wat::parse_str("(module)").unwrap()).unwrap();

    let runtime = Runtime::new().unwrap();
    let err = match runtime.compile_component(runtime.engine(), &core) {
        Ok(_) => panic!("core module must not be accepted by Component backend"),
        Err(err) => err,
    };
    assert!(err.to_string().contains("compiling wasm component"));
}

#[test]
fn registry_routes_component_artifacts_into_the_component_backend() {
    let dir = tmpdir("registry-component");
    let component = dir.join("component.wasm");
    std::fs::write(&component, wat::parse_str("(component)").unwrap()).unwrap();

    let mut registry = Registry::new(Runtime::new().unwrap());
    let err = match registry.load("component", &component, serde_json::Value::Null) {
        Ok(_) => panic!("an empty Component must fail because it exports no lifecycle interface"),
        Err(err) => err,
    };
    let message = err.to_string();
    assert!(
        message.contains("wasm-plugin-host:plugin/lifecycle@0.1.0"),
        "Component should reach the generated lifecycle backend; got: {message}"
    );
}
