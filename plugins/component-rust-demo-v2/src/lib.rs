wit_bindgen::generate!({
    path: "../../wit-v0.2",
    world: "plugin",
});

struct Demo;

use wasm_plugin_host::plugin::types::{
    AgentCapabilities, CapabilityRequest, FilesystemCapabilities, HookDecl, InvokeError,
    InvokeResult, InvokeSuccess, NetworkCapabilities, PluginDecl, ServiceCapabilities, ToolDecl,
    UiCapabilities,
};

impl exports::wasm_plugin_host::plugin::lifecycle::Guest for Demo {
    fn abi_version() -> u32 {
        1
    }

    fn init() -> Result<(), String> {
        Ok(())
    }

    fn configure(_config_json: String) -> Result<(), String> {
        Ok(())
    }

    fn describe() -> PluginDecl {
        PluginDecl {
            name: "component-rust-demo-v2".into(),
            abi: 1,
            tools: vec![
                ToolDecl {
                    name: "component_base_v2".into(),
                    description: "Base tool for the WIT 0.2 dependency demo".into(),
                    parameters_json: r#"{"type":"object"}"#.into(),
                    exec: "base".into(),
                    requires: vec![],
                },
                ToolDecl {
                    name: "component_echo_v2".into(),
                    description: "Echo through WIT 0.2 after the base tool is ready".into(),
                    parameters_json: r#"{"type":"object"}"#.into(),
                    exec: "echo".into(),
                    requires: vec!["component_base_v2".into()],
                },
            ],
            hooks: Vec::<HookDecl>::new(),
            injects: Vec::new(),
            provides: Vec::new(),
            capabilities: CapabilityRequest {
                filesystem: FilesystemCapabilities {
                    read: Vec::new(),
                    write: Vec::new(),
                    create: Vec::new(),
                    delete: Vec::new(),
                },
                network: NetworkCapabilities {
                    allow: Vec::new(),
                    methods: Vec::new(),
                },
                agent: AgentCapabilities {
                    observe: Vec::new(),
                    rewrite: Vec::new(),
                    veto: Vec::new(),
                },
                services: ServiceCapabilities {
                    consume: Vec::new(),
                    provide: Vec::new(),
                },
                ui: UiCapabilities {
                    slots: Vec::new(),
                    routes: Vec::new(),
                    windows: false,
                    theme: false,
                    adjusts: Vec::new(),
                    backend_commands: Vec::new(),
                    host_events: Vec::new(),
                },
            },
            ui_json: None,
        }
    }

    fn invoke(op: String, args_json: String) -> InvokeResult {
        match op.as_str() {
            "base" => InvokeResult::Success(InvokeSuccess {
                content: "component v2 base".into(),
                value_json: r#"{"ready":true}"#.into(),
            }),
            "echo" => InvokeResult::Success(InvokeSuccess {
                content: "component v2 echo".into(),
                value_json: args_json,
            }),
            _ => InvokeResult::Error(InvokeError {
                code: "unknown_op".into(),
                message: format!("unknown op: {op}"),
                value_json: "null".into(),
            }),
        }
    }

    fn shutdown() {}
}

export!(Demo);
