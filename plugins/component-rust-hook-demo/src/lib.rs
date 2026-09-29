wit_bindgen::generate!({
    path: "wit",
    world: "plugin",
});

struct Demo;

use wasm_plugin_host::plugin::types::{
    AgentCapabilities, CapabilityRequest, FilesystemCapabilities, HookDecision, HookDecl,
    HookMode, InvokeError, InvokeResult, InvokeSuccess, NetworkCapabilities, PluginDecl,
    ServiceCapabilities, ToolDecl, UiCapabilities,
};

impl exports::wasm_plugin_host::plugin::lifecycle::Guest for Demo {
    fn abi_version() -> u32 { 1 }
    fn init() -> Result<(), String> { Ok(()) }
    fn configure(_config_json: String) -> Result<(), String> { Ok(()) }

    fn describe() -> PluginDecl {
        PluginDecl {
            name: "component-rust-hook-demo".into(),
            abi: 1,
            tools: vec![ToolDecl {
                name: "typed_hook_echo".into(),
                description: "Echo JSON through WIT 0.4".into(),
                parameters_json: r#"{"type":"object"}"#.into(),
                exec: "echo".into(),
                requires: vec![],
            }],
            hooks: vec![HookDecl {
                on: "tools/pre-execute".into(),
                exec: "guard".into(),
                mode: HookMode::Waterfall,
                priority: 0,
            }],
            injects: vec![],
            provides: vec![],
            capabilities: CapabilityRequest {
                filesystem: FilesystemCapabilities { read: vec![], write: vec![], create: vec![], delete: vec![] },
                network: NetworkCapabilities { allow: vec![], methods: vec![] },
                agent: AgentCapabilities {
                    observe: vec![],
                    rewrite: vec!["tools/pre-execute".into()],
                    veto: vec!["tools/pre-execute".into()],
                },
                services: ServiceCapabilities { consume: vec![], provide: vec![] },
                ui: UiCapabilities {
                    slots: vec![], routes: vec![], windows: false, theme: false,
                    adjusts: vec![], backend_commands: vec![], host_events: vec![],
                },
            },
            ui: None,
        }
    }

    fn invoke(op: String, args_json: String) -> InvokeResult {
        if op == "echo" {
            InvokeResult::Success(InvokeSuccess {
                content: "typed hook echo".into(),
                value_json: args_json,
            })
        } else {
            InvokeResult::Error(InvokeError {
                code: "unknown_op".into(),
                message: format!("unknown op: {op}"),
                value_json: "null".into(),
            })
        }
    }

    fn invoke_hook(op: String, _args_json: String) -> HookDecision {
        if op == "guard" {
            HookDecision::Veto("blocked by WIT 0.4 typed hook".into())
        } else {
            HookDecision::Continue
        }
    }

    fn shutdown() {}
}

export!(Demo);
