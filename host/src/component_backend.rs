//! Component Model backend bindings generated from `wit/plugin.wit`.
//!
//! This module is deliberately separate from the core-module linker. Both
//! backends share `HostState`, CapabilityGate and AuditSink.

use crate::state::{HostState, LogLevel, LogRecord};
use anyhow::Result;
use std::sync::atomic::Ordering;
use wasmtime::component::{HasSelf, Linker};
use wasmtime::Engine;

wasmtime::component::bindgen!({
    path: "../wit",
    world: "plugin",
});

impl wasm_plugin_host::plugin::types::Host for HostState {}

impl wasm_plugin_host::plugin::host_log::Host for HostState {
    fn log(&mut self, level: wasm_plugin_host::plugin::types::LogLevel, message: String) {
        if self.charge_log_bytes(message.len() as u64).is_err() {
            return;
        }
        let level = match level {
            wasm_plugin_host::plugin::types::LogLevel::Debug => LogLevel::Debug,
            wasm_plugin_host::plugin::types::LogLevel::Info => LogLevel::Info,
            wasm_plugin_host::plugin::types::LogLevel::Warn => LogLevel::Warn,
            wasm_plugin_host::plugin::types::LogLevel::Error => LogLevel::Error,
        };
        self.log.push(LogRecord {
            seq: 0,
            slot: self.slot.clone(),
            plugin: self.plugin_name.clone(),
            level,
            message,
        });
    }

    fn now_ms(&mut self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64
    }
}

impl wasm_plugin_host::plugin::host_config::Host for HostState {
    fn get_config(&mut self) -> String {
        serde_json::to_string(&*self.config.lock().unwrap()).unwrap_or_else(|_| "null".into())
    }

    fn config_version(&mut self) -> u64 {
        self.config_version.load(Ordering::SeqCst).max(0) as u64
    }
}

impl wasm_plugin_host::plugin::host_network::Host for HostState {
    fn http_fetch(
        &mut self,
        request: wasm_plugin_host::plugin::types::HttpRequest,
    ) -> std::result::Result<wasm_plugin_host::plugin::types::HttpResponse, String> {
        self.capability_gate
            .require_http(&request.url, &request.method)?;

        let headers = request
            .headers
            .iter()
            .map(|h| (h.name.clone(), serde_json::Value::String(h.value.clone())))
            .collect::<serde_json::Map<_, _>>();
        let req = serde_json::json!({
            "url": request.url,
            "method": request.method,
            "headers": headers,
            "body": request.body,
        });
        let max_redirects = if self.policy.trust == crate::capability::TrustMode::Sandboxed {
            0
        } else {
            10
        };
        let reply = crate::runtime::http_fetch_json(
            &req.to_string(),
            self.http_timeout,
            max_redirects,
            self.capability_gate.clone(),
        );
        if let Some(error) = reply.get("error").and_then(|v| v.as_str()) {
            return Err(error.to_string());
        }
        let status = reply
            .get("status")
            .and_then(|v| v.as_u64())
            .and_then(|n| u16::try_from(n).ok())
            .ok_or_else(|| "http response is missing a valid status".to_string())?;
        let headers = reply
            .get("headers")
            .and_then(|v| v.as_object())
            .map(|headers| {
                headers
                    .iter()
                    .map(
                        |(name, value)| wasm_plugin_host::plugin::types::HttpHeader {
                            name: name.clone(),
                            value: value.as_str().unwrap_or("").to_string(),
                        },
                    )
                    .collect()
            })
            .unwrap_or_default();
        let body = reply
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Ok(wasm_plugin_host::plugin::types::HttpResponse {
            status,
            headers,
            body,
        })
    }
}

impl wasm_plugin_host::plugin::host_filesystem::Host for HostState {
    fn read_file(&mut self, root: String, path: String) -> std::result::Result<Vec<u8>, String> {
        self.capability_gate.require_filesystem_read(&root, &path)?;
        let relative = crate::runtime::safe_relative_fs_path(&path)?;
        crate::runtime::with_fs_root(self, &root, |dir| {
            use std::io::Read as _;
            let mut file = dir
                .open(&relative)
                .map_err(|e| format!("fs read_file open failed: {e}"))?;
            let mut data = Vec::new();
            file.read_to_end(&mut data)
                .map_err(|e| format!("fs read_file failed: {e}"))?;
            Ok(data)
        })
    }

    fn write_file(
        &mut self,
        root: String,
        path: String,
        data: Vec<u8>,
    ) -> std::result::Result<(), String> {
        component_fs_mutation(self, "write_file", root, path, Some(data))
    }

    fn create_file(
        &mut self,
        root: String,
        path: String,
        data: Vec<u8>,
    ) -> std::result::Result<(), String> {
        component_fs_mutation(self, "create_file", root, path, Some(data))
    }

    fn delete_file(&mut self, root: String, path: String) -> std::result::Result<(), String> {
        component_fs_mutation(self, "delete_file", root, path, None)
    }

    fn create_dir(&mut self, root: String, path: String) -> std::result::Result<(), String> {
        component_fs_mutation(self, "create_dir", root, path, None)
    }

    fn delete_dir(&mut self, root: String, path: String) -> std::result::Result<(), String> {
        component_fs_mutation(self, "delete_dir", root, path, None)
    }
}

impl wasm_plugin_host::plugin::host_services::Host for HostState {
    fn has_service(&mut self, service: String) -> bool {
        if self
            .capability_gate
            .require_service_consume(&service)
            .is_err()
        {
            return false;
        }
        self.services
            .as_ref()
            .map(|shared| shared.provider(&service).is_some() || shared.is_external(&service))
            .unwrap_or(false)
    }

    fn call_service(
        &mut self,
        service: String,
        op: String,
        args_json: String,
    ) -> std::result::Result<String, String> {
        self.capability_gate.require_service_consume(&service)?;
        let args: serde_json::Value =
            serde_json::from_str(&args_json).map_err(|e| format!("bad service args JSON: {e}"))?;
        let shared = self
            .services
            .as_ref()
            .ok_or_else(|| "service bridge is not configured".to_string())?;
        let result = shared
            .call_service(&service, &op, &args)
            .map_err(|e| e.to_string())?;
        serde_json::to_string(&result).map_err(|e| format!("serializing service result: {e}"))
    }
}

#[allow(dead_code)] // Phase E: used once Component lifecycle is routed by Plugin.
fn component_fs_mutation(
    state: &HostState,
    op: &str,
    root: String,
    path: String,
    data: Option<Vec<u8>>,
) -> std::result::Result<(), String> {
    use base64::Engine as _;

    let mut request = serde_json::json!({
        "op": op,
        "root": root,
        "path": path,
    });
    if let Some(data) = data {
        request["data_b64"] =
            serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(data));
    }
    let reply = crate::runtime::fs_op_json(state, &request.to_string());
    if let Some(error) = reply.get("error").and_then(|v| v.as_str()) {
        Err(error.to_string())
    } else {
        Ok(())
    }
}

#[allow(dead_code)] // Phase E staged backend; runtime dispatch is the next step.
pub(crate) struct ComponentInstance {
    pub(crate) store: wasmtime::Store<HostState>,
    pub(crate) bindings: Plugin,
}

#[allow(dead_code)]
impl ComponentInstance {
    fn prepare_guest_call(&mut self) -> Result<()> {
        crate::runtime::prepare_store_budget(&mut self.store)
    }
    pub(crate) fn instantiate(
        engine: &Engine,
        component: &wasmtime::component::Component,
        state: HostState,
    ) -> Result<Self> {
        let linker = component_linker(engine)?;
        let mut store = wasmtime::Store::new(engine, state);
        store.limiter(|state| &mut state.store_limits);
        crate::runtime::prepare_store_budget(&mut store)?;
        let bindings = Plugin::instantiate(&mut store, component, &linker)?;
        Ok(Self { store, bindings })
    }

    pub(crate) fn abi_version(&mut self) -> Result<u32> {
        self.prepare_guest_call()?;
        Ok(self
            .bindings
            .wasm_plugin_host_plugin_lifecycle()
            .call_abi_version(&mut self.store)?)
    }

    pub(crate) fn init(&mut self) -> Result<()> {
        self.prepare_guest_call()?;
        self.bindings
            .wasm_plugin_host_plugin_lifecycle()
            .call_init(&mut self.store)?
            .map_err(anyhow::Error::msg)
    }

    pub(crate) fn configure(&mut self, config_json: &str) -> Result<()> {
        self.prepare_guest_call()?;
        let config_json = config_json.to_string();
        self.bindings
            .wasm_plugin_host_plugin_lifecycle()
            .call_configure(&mut self.store, &config_json)?
            .map_err(anyhow::Error::msg)
    }

    pub(crate) fn describe(&mut self) -> Result<wasm_plugin_host::plugin::types::PluginDecl> {
        self.prepare_guest_call()?;
        Ok(self
            .bindings
            .wasm_plugin_host_plugin_lifecycle()
            .call_describe(&mut self.store)?)
    }

    pub(crate) fn describe_internal(&mut self) -> Result<crate::plugin::PluginDecl> {
        component_decl_to_internal(self.describe()?)
    }

    pub(crate) fn invoke(
        &mut self,
        op: &str,
        args_json: &str,
    ) -> Result<wasm_plugin_host::plugin::types::InvokeResult> {
        self.prepare_guest_call()?;
        let args_json = args_json.to_string();
        Ok(self
            .bindings
            .wasm_plugin_host_plugin_lifecycle()
            .call_invoke(&mut self.store, op, &args_json)?)
    }

    pub(crate) fn invoke_internal(
        &mut self,
        op: &str,
        args_json: &str,
    ) -> Result<crate::plugin::InvokeResult> {
        match self.invoke(op, args_json)? {
            wasm_plugin_host::plugin::types::InvokeResult::Success(success) => {
                Ok(crate::plugin::InvokeResult::Success {
                    content: success.content,
                    value: parse_json_value(&success.value_json, "component invoke value")?,
                })
            }
            wasm_plugin_host::plugin::types::InvokeResult::Error(error) => {
                Ok(crate::plugin::InvokeResult::Error {
                    message: error.message,
                    code: error.code,
                })
            }
        }
    }

    pub(crate) fn invoke_raw_json(
        &mut self,
        op: &str,
        args_json: &str,
    ) -> Result<serde_json::Value> {
        match self.invoke(op, args_json)? {
            wasm_plugin_host::plugin::types::InvokeResult::Success(success) => {
                parse_json_value(&success.value_json, "component raw invoke value")
            }
            wasm_plugin_host::plugin::types::InvokeResult::Error(error) => Ok(serde_json::json!({
                "kind": "error",
                "message": error.message,
                "code": error.code,
            })),
        }
    }

    pub(crate) fn shutdown(&mut self) -> Result<()> {
        self.prepare_guest_call()?;
        Ok(self
            .bindings
            .wasm_plugin_host_plugin_lifecycle()
            .call_shutdown(&mut self.store)?)
    }
}

fn parse_json_value(raw: &str, label: &str) -> Result<serde_json::Value> {
    serde_json::from_str(raw).map_err(|e| anyhow::anyhow!("invalid {label} JSON ({e}): {raw}"))
}

fn component_decl_to_internal(
    decl: wasm_plugin_host::plugin::types::PluginDecl,
) -> Result<crate::plugin::PluginDecl> {
    use self::wasm_plugin_host::plugin::types as wit;

    let tools = decl
        .tools
        .into_iter()
        .map(|tool| {
            Ok(crate::plugin::ToolDecl {
                name: tool.name,
                description: tool.description,
                parameters: parse_json_value(&tool.parameters_json, "tool parameters")?,
                exec: tool.exec,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let hooks = decl
        .hooks
        .into_iter()
        .map(|hook| crate::plugin::HookDecl {
            on: hook.on,
            exec: hook.exec,
            mode: match hook.mode {
                wit::HookMode::Observe => crate::plugin::HookMode::Observe,
                wit::HookMode::Waterfall => crate::plugin::HookMode::Waterfall,
            },
            priority: hook.priority,
        })
        .collect();

    let ui = match decl.ui_json {
        Some(raw) => Some(
            serde_json::from_str(&raw)
                .map_err(|e| anyhow::anyhow!("invalid component ui-json ({e}): {raw}"))?,
        ),
        None => None,
    };

    Ok(crate::plugin::PluginDecl {
        name: decl.name,
        abi: i32::try_from(decl.abi)
            .map_err(|_| anyhow::anyhow!("component ABI value does not fit i32"))?,
        tools,
        hooks,
        injects: decl.injects,
        provides: decl.provides,
        ui,
        capabilities: component_capabilities_to_internal(decl.capabilities),
    })
}

fn component_capabilities_to_internal(
    caps: wasm_plugin_host::plugin::types::CapabilityRequest,
) -> crate::capability::CapabilitySet {
    crate::capability::CapabilitySet {
        filesystem: crate::capability::FilesystemCapabilities {
            read: caps.filesystem.read,
            write: caps.filesystem.write,
            create: caps.filesystem.create,
            delete: caps.filesystem.delete,
        },
        network: crate::capability::NetworkCapabilities {
            allow: caps.network.allow,
            methods: caps.network.methods,
        },
        agent: crate::capability::AgentCapabilities {
            observe: caps.agent.observe,
            rewrite: caps.agent.rewrite,
            veto: caps.agent.veto,
        },
        services: crate::capability::ServiceCapabilities {
            consume: caps.services.consume,
            provide: caps.services.provide,
        },
        ui: crate::capability::UiCapabilities {
            slots: caps.ui.slots,
            routes: caps.ui.routes,
            windows: caps.ui.windows,
            theme: caps.ui.theme,
            adjusts: caps.ui.adjusts,
            backend_commands: caps.ui.backend_commands,
            host_events: caps.ui.host_events,
        },
    }
}

#[allow(dead_code)]
pub(crate) fn component_linker(engine: &Engine) -> Result<Linker<HostState>> {
    let mut linker = Linker::new(engine);
    Plugin::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)?;
    // Preview2 is linked for all Component guests so language runtimes such as
    // StarlingMonkey can instantiate. Authority comes from HostState: sandboxed
    // contexts get only read preopens, raw sockets stay denied, and wasi:http
    // is checked by Preview2HttpHooks against the same CapabilityGate.
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker)?;
    wasmtime_wasi_http::p2::add_only_http_to_linker_sync(&mut linker)?;
    Ok(linker)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::{
        CapabilitySet, FilesystemCapabilities, NetworkCapabilities, PluginPolicy, TrustMode,
    };
    use crate::state::LogSink;
    use std::sync::Arc;

    fn sandbox_state(grant: CapabilitySet) -> HostState {
        let policy = PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: grant.clone(),
            ..Default::default()
        };
        let state = HostState::new_with_policy(
            "component-test",
            "component-test",
            serde_json::json!({"hello":"component"}),
            Arc::new(LogSink::new(32, false, None)),
            None,
            policy,
        );
        state.resolve_declared_capabilities(&grant);
        state
    }

    #[test]
    fn component_linker_accepts_existing_host_state_contract() {
        let runtime = crate::runtime::Runtime::new().unwrap();
        component_linker(runtime.engine()).expect("generated WIT imports should link to HostState");
    }

    #[test]
    fn trusted_component_linker_composes_preview2_and_http_once() {
        let runtime = crate::runtime::Runtime::new().unwrap();
        component_linker(runtime.engine()).expect(
            "Component linker should compose Preview2 + wasi:http without duplicate interfaces",
        );
    }

    #[test]
    fn component_filesystem_read_reuses_the_same_grant_boundary() {
        use wasm_plugin_host::plugin::host_filesystem::Host as _;

        let root =
            std::env::temp_dir().join(format!("wasm-plugin-component-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("ok.txt"), b"COMPONENT_OK").unwrap();
        let root = root.to_string_lossy().to_string();

        let mut state = sandbox_state(CapabilitySet {
            filesystem: FilesystemCapabilities {
                read: vec![root.clone()],
                ..Default::default()
            },
            ..Default::default()
        });
        let data = state
            .read_file(root.clone(), "ok.txt".into())
            .expect("explicit read grant should work through WIT host import");
        assert_eq!(data, b"COMPONENT_OK");

        let denied = state.read_file("/".into(), "etc/passwd".into());
        assert!(denied.is_err(), "ungranted root must remain denied");
    }

    #[test]
    fn component_network_import_reuses_network_capability_gate() {
        use wasm_plugin_host::plugin::host_network::Host as _;

        let mut state = sandbox_state(CapabilitySet {
            network: NetworkCapabilities {
                allow: vec!["api.example.com".into()],
                methods: vec!["GET".into()],
            },
            ..Default::default()
        });
        let request = wasm_plugin_host::plugin::types::HttpRequest {
            url: "http://127.0.0.1:1/".into(),
            method: "GET".into(),
            headers: Vec::new(),
            body: None,
        };
        let err = state
            .http_fetch(request)
            .expect_err("WIT network import must not bypass host allowlist");
        assert!(err.contains("permission denied"), "got: {err}");
    }
}
