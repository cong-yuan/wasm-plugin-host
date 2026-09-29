wit_bindgen::generate!({
    path: "../../wit-v0.3",
    world: "plugin",
});

struct Demo;

use wasm_plugin_host::plugin::types::{
    AdjustAction, AgentCapabilities, CapabilityRequest, FilesystemCapabilities, HookDecl,
    InvokeError, InvokeResult, InvokeSuccess, NetworkCapabilities, PluginDecl, RouteDecl,
    ServiceCapabilities, SlotDecl, SlotInject, ToolDecl, UiAdjust, UiAsset, UiCapabilities, UiDecl,
    WindowContent, WindowDecl, WindowOpen,
};

impl exports::wasm_plugin_host::plugin::lifecycle::Guest for Demo {
    fn abi_version() -> u32 { 1 }

    fn init() -> Result<(), String> { Ok(()) }

    fn configure(_config_json: String) -> Result<(), String> { Ok(()) }

    fn describe() -> PluginDecl {
        PluginDecl {
            name: "component-rust-ui-demo".into(),
            abi: 1,
            tools: vec![
                ToolDecl {
                    name: "component_ui_base".into(),
                    description: "Base tool for typed dependency smoke".into(),
                    parameters_json: r#"{"type":"object"}"#.into(),
                    exec: "echo".into(),
                    requires: vec![],
                },
                ToolDecl {
                    name: "component_ui_echo".into(),
                    description: "Echo JSON through WIT 0.3".into(),
                    parameters_json: r#"{"type":"object"}"#.into(),
                    exec: "echo".into(),
                    requires: vec!["component_ui_base".into()],
                },
            ],
            hooks: Vec::<HookDecl>::new(),
            injects: vec![],
            provides: vec![],
            capabilities: CapabilityRequest {
                filesystem: FilesystemCapabilities { read: vec![], write: vec![], create: vec![], delete: vec![] },
                network: NetworkCapabilities { allow: vec![], methods: vec![] },
                agent: AgentCapabilities { observe: vec![], rewrite: vec![], veto: vec![] },
                services: ServiceCapabilities { consume: vec![], provide: vec![] },
                ui: UiCapabilities {
                    slots: vec!["demo.slot".into()],
                    routes: vec!["demo".into()],
                    windows: true,
                    theme: false,
                    adjusts: vec!["host.*".into()],
                    backend_commands: vec![],
                    host_events: vec![],
                },
            },
            ui: Some(UiDecl {
                provides: vec![SlotDecl {
                    name: "demo.slot".into(),
                    description: Some("Typed WIT 0.3 slot".into()),
                }],
                injects: vec![SlotInject {
                    slot: "host.main".into(),
                    priority: 10,
                    component: Some("DemoPanel".into()),
                }],
                assets: vec![UiAsset {
                    name: "entry.js".into(),
                    source: "studio.register('DemoPanel', (el) => { el.textContent = 'WIT 0.3'; })".into(),
                }],
                windows: vec![WindowDecl {
                    name: "demo".into(),
                    component: "DemoPanel".into(),
                    title: Some("Typed UI Demo".into()),
                    width: Some(640.0),
                    height: Some(480.0),
                    open: WindowOpen::Manual,
                    content: WindowContent::App,
                    html: None,
                }],
                routes: vec![RouteDecl {
                    path: "demo".into(),
                    component: "DemoPanel".into(),
                    title: Some("Demo".into()),
                    icon: None,
                    nav: true,
                }],
                adjusts: vec![UiAdjust {
                    slot: "host.*".into(),
                    from_plugin: None,
                    action: AdjustAction::Priority,
                    to: Some(5),
                    by: None,
                    component: None,
                }],
            }),
        }
    }

    fn invoke(op: String, args_json: String) -> InvokeResult {
        if op == "echo" {
            InvokeResult::Success(InvokeSuccess {
                content: "component ui echo".into(),
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

    fn shutdown() {}
}

export!(Demo);
