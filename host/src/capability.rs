//! Plugin capability policy.
//!
//! Phase A separates what a plugin requests, what the host grants, and what the
//! runtime actually enforces.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TrustMode {
    #[default]
    Trusted,
    Sandboxed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct FilesystemCapabilities {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub write: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub create: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delete: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct NetworkCapabilities {
    #[serde(default, skip_serializing_if = "Vec::is_empty", alias = "hosts")]
    pub allow: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AgentCapabilities {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observe: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rewrite: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub veto: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ServiceCapabilities {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consume: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provide: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct UiCapabilities {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slots: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub routes: Vec<String>,
    #[serde(default)]
    pub windows: bool,
    #[serde(default)]
    pub theme: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub adjusts: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub backend_commands: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CapabilitySet {
    #[serde(default)]
    pub filesystem: FilesystemCapabilities,
    #[serde(default)]
    pub network: NetworkCapabilities,
    #[serde(default)]
    pub agent: AgentCapabilities,
    #[serde(default)]
    pub services: ServiceCapabilities,
    #[serde(default)]
    pub ui: UiCapabilities,
}

impl CapabilitySet {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceLimits {
    #[serde(default = "default_memory_mb")]
    pub memory_mb: u64,
    #[serde(default = "default_fuel")]
    pub fuel: u64,
    #[serde(default = "default_call_timeout_ms")]
    pub call_timeout_ms: u64,
    #[serde(default = "default_max_concurrent_calls")]
    pub max_concurrent_calls: u32,
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: u64,
    #[serde(default = "default_max_log_bytes_per_call")]
    pub max_log_bytes_per_call: u64,
}

const fn default_memory_mb() -> u64 {
    64
}
const fn default_fuel() -> u64 {
    100_000_000
}
const fn default_call_timeout_ms() -> u64 {
    5_000
}
const fn default_max_concurrent_calls() -> u32 {
    1
}
const fn default_max_output_bytes() -> u64 {
    16 * 1024 * 1024
}
const fn default_max_log_bytes_per_call() -> u64 {
    1024 * 1024
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            memory_mb: default_memory_mb(),
            fuel: default_fuel(),
            call_timeout_ms: default_call_timeout_ms(),
            max_concurrent_calls: default_max_concurrent_calls(),
            max_output_bytes: default_max_output_bytes(),
            max_log_bytes_per_call: default_max_log_bytes_per_call(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct PluginPolicy {
    #[serde(default)]
    pub trust: TrustMode,
    #[serde(default)]
    pub grant: CapabilitySet,
    #[serde(default)]
    pub limits: ResourceLimits,
}

impl PluginPolicy {
    pub fn trusted() -> Self {
        Self::default()
    }

    pub fn validate_for_load(&self) -> Result<(), String> {
        if self.trust == TrustMode::Trusted {
            return Ok(());
        }
        if self.limits.max_concurrent_calls != 1 {
            return Err(format!(
                "sandboxed max_concurrent_calls must be 1 with the current single-instance-per-slot runtime (got {})",
                self.limits.max_concurrent_calls
            ));
        }
        for path in self
            .grant
            .filesystem
            .read
            .iter()
            .chain(self.grant.filesystem.write.iter())
            .chain(self.grant.filesystem.create.iter())
            .chain(self.grant.filesystem.delete.iter())
        {
            let raw = std::path::Path::new(path);
            if !raw.is_absolute() {
                return Err(format!(
                    "sandboxed filesystem grant must be an absolute path: `{path}`"
                ));
            }
            let canonical = std::fs::canonicalize(raw).map_err(|e| {
                format!("sandboxed filesystem grant `{path}` cannot be canonicalized: {e}")
            })?;
            if !canonical.is_dir() {
                return Err(format!(
                    "sandboxed filesystem grant `{path}` is not a directory"
                ));
            }
        }
        let mut canonical_roots = Vec::new();
        for path in self.grant.filesystem.read.iter() {
            let raw = std::path::Path::new(path);
            let canonical = std::fs::canonicalize(raw).map_err(|e| {
                format!("sandboxed filesystem grant `{path}` cannot be canonicalized: {e}")
            })?;
            if !canonical_roots.iter().any(|p: &std::path::PathBuf| p == &canonical) {
                canonical_roots.push(canonical);
            }
        }

        for (i, root) in canonical_roots.iter().enumerate() {
            for other in canonical_roots.iter().skip(i + 1) {
                let (parent, child) = if other.starts_with(root) {
                    (root, other)
                } else if root.starts_with(other) {
                    (other, root)
                } else {
                    continue;
                };
                return Err(format!(
                    "overlapping sandboxed filesystem grants are ambiguous: `{}` contains `{}`; grant only the narrower root or only the broader root",
                    parent.display(),
                    child.display()
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveCapabilities {
    pub trust: TrustMode,
    pub capabilities: CapabilitySet,
    unrestricted: bool,
}

/// Single enforcement point carried by each plugin instance.
#[derive(Debug, Clone)]
pub struct CapabilityGate {
    effective: Arc<RwLock<EffectiveCapabilities>>,
    audit: Option<AuditContext>,
}

#[derive(Debug, Clone)]
struct AuditContext {
    sink: Arc<crate::audit::AuditSink>,
    slot: String,
    plugin: String,
}

impl CapabilityGate {
    pub fn new(policy: &PluginPolicy) -> Self {
        Self {
            effective: Arc::new(RwLock::new(EffectiveCapabilities::bootstrap(policy))),
            audit: None,
        }
    }

    pub fn with_audit(
        policy: &PluginPolicy,
        sink: Arc<crate::audit::AuditSink>,
        slot: impl Into<String>,
        plugin: impl Into<String>,
    ) -> Self {
        Self {
            effective: Arc::new(RwLock::new(EffectiveCapabilities::bootstrap(policy))),
            audit: Some(AuditContext {
                sink,
                slot: slot.into(),
                plugin: plugin.into(),
            }),
        }
    }

    pub fn resolve(&self, policy: &PluginPolicy, requested: &CapabilitySet) {
        *self.effective.write().unwrap() = EffectiveCapabilities::resolve(policy, requested);
    }

    pub fn require_http(&self, url: &str, method: &str) -> Result<(), String> {
        let result = self.effective.read().unwrap().allows_http(url, method);
        let target = url
            .parse::<ureq::http::Uri>()
            .ok()
            .and_then(|uri| uri.host().map(str::to_string))
            .map(|host| format!("{method} {host}"))
            .unwrap_or_else(|| format!("{method} <invalid-url>"));
        self.audit_result("network.http", &target, &result);
        result
    }

    pub fn require_filesystem_write(&self, root: &str, path: &str) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = effective.allows_named(
            "filesystem write root",
            root,
            &effective.capabilities.filesystem.write,
        );
        drop(effective);
        self.audit_result("filesystem.write", &format!("{root}:{path}"), &result);
        result
    }

    pub fn require_filesystem_create(&self, root: &str, path: &str) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = effective.allows_named(
            "filesystem create root",
            root,
            &effective.capabilities.filesystem.create,
        );
        drop(effective);
        self.audit_result("filesystem.create", &format!("{root}:{path}"), &result);
        result
    }

    pub fn require_filesystem_delete(&self, root: &str, path: &str) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = effective.allows_named(
            "filesystem delete root",
            root,
            &effective.capabilities.filesystem.delete,
        );
        drop(effective);
        self.audit_result("filesystem.delete", &format!("{root}:{path}"), &result);
        result
    }

    pub fn require_service_consume(&self, service: &str) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = effective.allows_named(
            "service consume",
            service,
            &effective.capabilities.services.consume,
        );
        drop(effective);
        self.audit_result("services.consume", service, &result);
        result
    }

    pub fn require_service_provide(&self, service: &str) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = effective.allows_named(
            "service provide",
            service,
            &effective.capabilities.services.provide,
        );
        drop(effective);
        self.audit_result("services.provide", service, &result);
        result
    }

    pub fn require_agent_observe(&self, event: &str) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = effective.allows_named(
            "agent observe",
            event,
            &effective.capabilities.agent.observe,
        );
        drop(effective);
        self.audit_result("agent.observe", event, &result);
        result
    }

    pub fn require_agent_rewrite(&self, event: &str) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = effective.allows_named(
            "agent rewrite",
            event,
            &effective.capabilities.agent.rewrite,
        );
        drop(effective);
        self.audit_result("agent.rewrite", event, &result);
        result
    }

    pub fn require_agent_veto(&self, event: &str) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = effective.allows_named("agent veto", event, &effective.capabilities.agent.veto);
        drop(effective);
        self.audit_result("agent.veto", event, &result);
        result
    }

    pub fn require_ui_slot(&self, slot: &str) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = effective.allows_named("ui slot", slot, &effective.capabilities.ui.slots);
        drop(effective);
        self.audit_result("ui.slots", slot, &result);
        result
    }

    pub fn require_ui_route(&self, route: &str) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = effective.allows_named("ui route", route, &effective.capabilities.ui.routes);
        drop(effective);
        self.audit_result("ui.routes", route, &result);
        result
    }

    pub fn require_ui_window(&self) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = if effective.unrestricted || effective.capabilities.ui.windows {
            Ok(())
        } else {
            Err("permission denied: ui windows are not granted".to_string())
        };
        drop(effective);
        self.audit_result("ui.windows", "window", &result);
        result
    }

    pub fn require_ui_theme(&self) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = if effective.unrestricted || effective.capabilities.ui.theme {
            Ok(())
        } else {
            Err("permission denied: ui theme is not granted".to_string())
        };
        drop(effective);
        self.audit_result("ui.theme", "theme", &result);
        result
    }

    pub fn require_ui_adjust(&self, slot: &str) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result =
            effective.allows_patterned("ui adjust", slot, &effective.capabilities.ui.adjusts);
        drop(effective);
        self.audit_result("ui.adjusts", slot, &result);
        result
    }

    pub fn require_ui_backend_command(&self, command: &str) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = effective.allows_named(
            "ui backend command",
            command,
            &effective.capabilities.ui.backend_commands,
        );
        drop(effective);
        self.audit_result("ui.backend_commands", command, &result);
        result
    }

    pub fn require_ui_assets(&self) -> Result<(), String> {
        let effective = self.effective.read().unwrap();
        let result = if effective.unrestricted || effective.has_any_ui_capability() {
            Ok(())
        } else {
            Err("permission denied: UI assets require an effective UI capability".to_string())
        };
        drop(effective);
        self.audit_result("ui.assets", "assets", &result);
        result
    }

    pub fn snapshot(&self) -> EffectiveCapabilities {
        self.effective.read().unwrap().clone()
    }

    fn audit_result(&self, capability: &str, target: &str, result: &Result<(), String>) {
        let Some(audit) = &self.audit else {
            return;
        };
        match result {
            Ok(()) => audit.sink.record(
                &audit.slot,
                &audit.plugin,
                crate::audit::AuditDecision::Allow,
                capability,
                target,
                None,
            ),
            Err(reason) => audit.sink.record(
                &audit.slot,
                &audit.plugin,
                crate::audit::AuditDecision::Deny,
                capability,
                target,
                Some(reason),
            ),
        }
    }
}

impl EffectiveCapabilities {
    pub fn bootstrap(policy: &PluginPolicy) -> Self {
        match policy.trust {
            TrustMode::Trusted => Self {
                trust: TrustMode::Trusted,
                capabilities: CapabilitySet::default(),
                unrestricted: true,
            },
            TrustMode::Sandboxed => Self {
                trust: TrustMode::Sandboxed,
                capabilities: CapabilitySet::default(),
                unrestricted: false,
            },
        }
    }

    pub fn resolve(policy: &PluginPolicy, requested: &CapabilitySet) -> Self {
        if policy.trust == TrustMode::Trusted {
            return Self::bootstrap(policy);
        }
        Self {
            trust: TrustMode::Sandboxed,
            capabilities: intersect_set(requested, &policy.grant),
            unrestricted: false,
        }
    }

    fn allows_named(&self, kind: &str, value: &str, allowed: &[String]) -> Result<(), String> {
        if self.unrestricted {
            return Ok(());
        }
        if allowed.iter().any(|v| v == "*" || v == value) {
            Ok(())
        } else {
            Err(format!(
                "permission denied: {kind} `{value}` is not granted"
            ))
        }
    }

    fn allows_patterned(&self, kind: &str, value: &str, allowed: &[String]) -> Result<(), String> {
        if self.unrestricted {
            return Ok(());
        }
        if allowed.iter().any(|pattern| {
            pattern == "*"
                || pattern == value
                || pattern
                    .strip_suffix('*')
                    .is_some_and(|prefix| value.starts_with(prefix))
        }) {
            Ok(())
        } else {
            Err(format!(
                "permission denied: {kind} `{value}` is not granted"
            ))
        }
    }

    fn has_any_ui_capability(&self) -> bool {
        let ui = &self.capabilities.ui;
        !ui.slots.is_empty()
            || !ui.routes.is_empty()
            || ui.windows
            || ui.theme
            || !ui.adjusts.is_empty()
            || !ui.backend_commands.is_empty()
    }

    pub fn allows_http(&self, url: &str, method: &str) -> Result<(), String> {
        if self.unrestricted {
            return Ok(());
        }
        let uri: ureq::http::Uri = url
            .parse()
            .map_err(|_| "permission denied: invalid http URL".to_string())?;
        let host = uri
            .host()
            .ok_or_else(|| "permission denied: URL has no host".to_string())?
            .to_ascii_lowercase();
        let net = &self.capabilities.network;
        let sensitive = sensitive_network_target(&host);
        let allowed = if sensitive {
            // Wildcards are too broad for loopback, private/link-local, IP
            // literals, and well-known metadata hosts. These targets require an
            // exact grant so `*` cannot silently turn into SSRF authority.
            net.allow.iter().any(|p| p.trim().eq_ignore_ascii_case(&host))
        } else {
            net.allow.iter().any(|p| host_matches(p, &host))
        };
        if !allowed {
            let suffix = if sensitive {
                " (sensitive targets require an exact host grant)"
            } else {
                ""
            };
            return Err(format!(
                "permission denied: network host {host} is not granted{suffix}"
            ));
        }
        if !net.methods.is_empty() && !net.methods.iter().any(|m| m.eq_ignore_ascii_case(method)) {
            return Err(format!(
                "permission denied: HTTP method {method} is not granted"
            ));
        }
        Ok(())
    }

    pub fn allows_resolved_ip(&self, ip: std::net::IpAddr) -> Result<(), String> {
        if self.unrestricted || !sensitive_resolved_ip(ip) {
            return Ok(());
        }
        let needle = ip.to_string();
        if self
            .capabilities
            .network
            .allow
            .iter()
            .any(|host| host.trim().eq_ignore_ascii_case(&needle))
        {
            return Ok(());
        }
        Err(format!(
            "permission denied: resolved sensitive IP {needle} requires an exact IP grant"
        ))
    }
}

fn host_matches(pattern: &str, host: &str) -> bool {
    let pattern = pattern.trim().to_ascii_lowercase();
    if pattern == "*" {
        return true;
    }
    if let Some(suffix) = pattern.strip_prefix("*.") {
        return host != suffix && host.ends_with(&format!(".{suffix}"));
    }
    host == pattern
}

fn sensitive_network_target(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || matches!(
            host.as_str(),
            "metadata.google.internal"
                | "metadata.google"
                | "instance-data.ec2.internal"
                | "metadata.azure.internal"
        )
    {
        return true;
    }

    // Every IP literal is treated as sensitive. This includes loopback,
    // RFC1918/ULA, link-local and cloud metadata addresses, while also making
    // public IP grants deliberate instead of letting `*` authorize them.
    host.parse::<std::net::IpAddr>().is_ok()
}

fn sensitive_resolved_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let first = v4.octets()[0];
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                || first == 0
        }
        std::net::IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
        }
    }
}

fn intersect_set(requested: &CapabilitySet, granted: &CapabilitySet) -> CapabilitySet {
    CapabilitySet {
        filesystem: FilesystemCapabilities {
            read: intersect_list(&requested.filesystem.read, &granted.filesystem.read),
            write: intersect_list(&requested.filesystem.write, &granted.filesystem.write),
            create: intersect_list(&requested.filesystem.create, &granted.filesystem.create),
            delete: intersect_list(&requested.filesystem.delete, &granted.filesystem.delete),
        },
        network: NetworkCapabilities {
            allow: intersect_hosts(&requested.network.allow, &granted.network.allow),
            methods: intersect_methods(&requested.network.methods, &granted.network.methods),
        },
        agent: AgentCapabilities {
            observe: intersect_list(&requested.agent.observe, &granted.agent.observe),
            rewrite: intersect_list(&requested.agent.rewrite, &granted.agent.rewrite),
            veto: intersect_list(&requested.agent.veto, &granted.agent.veto),
        },
        services: ServiceCapabilities {
            consume: intersect_list(&requested.services.consume, &granted.services.consume),
            provide: intersect_list(&requested.services.provide, &granted.services.provide),
        },
        ui: UiCapabilities {
            slots: intersect_list(&requested.ui.slots, &granted.ui.slots),
            routes: intersect_list(&requested.ui.routes, &granted.ui.routes),
            windows: requested.ui.windows && granted.ui.windows,
            theme: requested.ui.theme && granted.ui.theme,
            adjusts: intersect_list(&requested.ui.adjusts, &granted.ui.adjusts),
            backend_commands: intersect_list(
                &requested.ui.backend_commands,
                &granted.ui.backend_commands,
            ),
        },
    }
}

fn intersect_list(requested: &[String], granted: &[String]) -> Vec<String> {
    if requested.iter().any(|r| r == "*") {
        return granted.to_vec();
    }
    if granted.iter().any(|g| g == "*") {
        return requested.to_vec();
    }
    requested
        .iter()
        .filter(|r| granted.iter().any(|g| g == *r))
        .cloned()
        .collect()
}

fn intersect_methods(requested: &[String], granted: &[String]) -> Vec<String> {
    if requested.is_empty() {
        return granted.to_vec();
    }
    if granted.is_empty() {
        return requested.to_vec();
    }
    requested
        .iter()
        .filter(|r| {
            granted
                .iter()
                .any(|g| g == "*" || g.eq_ignore_ascii_case(r))
        })
        .cloned()
        .collect()
}

fn intersect_hosts(requested: &[String], granted: &[String]) -> Vec<String> {
    if requested.iter().any(|r| r == "*") {
        return granted.to_vec();
    }
    if granted.iter().any(|g| g == "*") {
        return requested.to_vec();
    }
    let mut out = Vec::new();
    for requested_host in requested {
        for grant in granted {
            let requested_lower = requested_host.to_ascii_lowercase();
            let grant_lower = grant.to_ascii_lowercase();
            let candidate = if requested_lower == grant_lower {
                Some(requested_host.clone())
            } else if !requested_lower.contains('*') && host_matches(grant, &requested_lower) {
                Some(requested_host.clone())
            } else if !grant_lower.contains('*') && host_matches(requested_host, &grant_lower) {
                Some(grant.clone())
            } else if let (Some(req_suffix), Some(grant_suffix)) = (
                requested_lower.strip_prefix("*."),
                grant_lower.strip_prefix("*."),
            ) {
                if req_suffix.ends_with(grant_suffix) {
                    Some(requested_host.clone())
                } else if grant_suffix.ends_with(req_suffix) {
                    Some(grant.clone())
                } else {
                    None
                }
            } else {
                None
            };
            if let Some(candidate) = candidate {
                if !out.contains(&candidate) {
                    out.push(candidate);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_network_is_request_intersection_grant() {
        let policy = PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                network: NetworkCapabilities {
                    allow: vec!["api.example.com".into()],
                    methods: vec!["GET".into()],
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let requested = CapabilitySet {
            network: NetworkCapabilities {
                allow: vec!["api.example.com".into(), "evil.example".into()],
                methods: vec!["GET".into(), "POST".into()],
            },
            ..Default::default()
        };
        let effective = EffectiveCapabilities::resolve(&policy, &requested);
        assert!(effective
            .allows_http("https://api.example.com/x", "GET")
            .is_ok());
        assert!(effective
            .allows_http("https://evil.example/x", "GET")
            .is_err());
        assert!(effective
            .allows_http("https://api.example.com/x", "POST")
            .is_err());
    }

    #[test]
    fn trusted_network_remains_unrestricted() {
        let effective = EffectiveCapabilities::bootstrap(&PluginPolicy::trusted());
        assert!(effective
            .allows_http("https://anything.example/x", "DELETE")
            .is_ok());
    }

    #[test]
    fn wildcard_host_grant_covers_an_exact_requested_host() {
        // ordinary DNS names may still be covered by a wildcard grant
        let policy = PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                network: NetworkCapabilities {
                    allow: vec!["*.example.com".into()],
                    methods: vec![],
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let requested = CapabilitySet {
            network: NetworkCapabilities {
                allow: vec!["api.example.com".into()],
                methods: vec!["POST".into()],
            },
            ..Default::default()
        };
        let effective = EffectiveCapabilities::resolve(&policy, &requested);
        assert!(effective
            .allows_http("https://api.example.com/x", "POST")
            .is_ok());
        assert!(effective
            .allows_http("https://api.example.com/x", "GET")
            .is_err());
    }

    #[test]
    fn wildcard_network_grant_does_not_authorize_sensitive_targets() {
        let policy = PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                network: NetworkCapabilities {
                    allow: vec!["*".into()],
                    methods: vec!["GET".into()],
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let requested = CapabilitySet {
            network: NetworkCapabilities {
                allow: vec!["*".into()],
                methods: vec!["GET".into()],
            },
            ..Default::default()
        };
        let effective = EffectiveCapabilities::resolve(&policy, &requested);

        assert!(effective
            .allows_http("https://example.com/", "GET")
            .is_ok());
        for url in [
            "http://127.0.0.1/",
            "http://10.0.0.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
            "http://localhost/",
            "http://metadata.google.internal/",
        ] {
            let err = effective
                .allows_http(url, "GET")
                .expect_err("wildcards must not authorize sensitive network targets");
            assert!(err.contains("exact host grant"), "url={url}, err={err}");
        }
    }

    #[test]
    fn sensitive_network_target_can_be_enabled_by_an_exact_grant() {
        let policy = PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                network: NetworkCapabilities {
                    allow: vec!["127.0.0.1".into(), "metadata.google.internal".into()],
                    methods: vec!["GET".into()],
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let requested = policy.grant.clone();
        let effective = EffectiveCapabilities::resolve(&policy, &requested);

        assert!(effective
            .allows_http("http://127.0.0.1:8080/", "GET")
            .is_ok());
        assert!(effective
            .allows_http("http://metadata.google.internal/", "GET")
            .is_ok());
    }

    #[test]
    fn resolved_private_ip_needs_an_exact_ip_grant() {
        let policy = PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                network: NetworkCapabilities {
                    allow: vec!["internal.example.com".into()],
                    methods: vec!["GET".into()],
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let requested = policy.grant.clone();
        let effective = EffectiveCapabilities::resolve(&policy, &requested);
        assert!(effective
            .allows_resolved_ip("10.0.0.8".parse().unwrap())
            .is_err());
        assert!(effective
            .allows_resolved_ip("93.184.216.34".parse().unwrap())
            .is_ok());
    }

    #[test]
    fn resolved_private_ip_can_be_explicitly_granted() {
        let policy = PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                network: NetworkCapabilities {
                    allow: vec!["internal.example.com".into(), "10.0.0.8".into()],
                    methods: vec!["GET".into()],
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let requested = policy.grant.clone();
        let effective = EffectiveCapabilities::resolve(&policy, &requested);
        assert!(effective
            .allows_resolved_ip("10.0.0.8".parse().unwrap())
            .is_ok());
    }

    #[test]
    fn wildcard_request_is_narrowed_to_named_grants() {
        let requested = CapabilitySet {
            services: ServiceCapabilities {
                consume: vec!["*".into()],
                ..Default::default()
            },
            network: NetworkCapabilities {
                allow: vec!["*".into()],
                ..Default::default()
            },
            ..Default::default()
        };
        let policy = PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                services: ServiceCapabilities {
                    consume: vec!["memory".into()],
                    ..Default::default()
                },
                network: NetworkCapabilities {
                    allow: vec!["api.example.com".into()],
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let effective = EffectiveCapabilities::resolve(&policy, &requested);
        assert_eq!(effective.capabilities.services.consume, vec!["memory"]);
        assert_eq!(
            effective.capabilities.network.allow,
            vec!["api.example.com"]
        );
    }

    #[test]
    fn future_ui_theme_and_backend_command_gates_use_effective_capabilities() {
        let policy = PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                ui: UiCapabilities {
                    theme: true,
                    backend_commands: vec!["open-file".into()],
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let requested = CapabilitySet {
            ui: UiCapabilities {
                theme: true,
                backend_commands: vec!["open-file".into(), "run-shell".into()],
                ..Default::default()
            },
            ..Default::default()
        };
        let gate = CapabilityGate::new(&policy);
        gate.resolve(&policy, &requested);

        assert!(gate.require_ui_theme().is_ok());
        assert!(gate.require_ui_backend_command("open-file").is_ok());
        assert!(gate.require_ui_backend_command("run-shell").is_err());
    }

    #[test]
    fn capability_gate_records_allow_and_deny_audit_events() {
        let policy = PluginPolicy {
            trust: TrustMode::Sandboxed,
            grant: CapabilitySet {
                services: ServiceCapabilities {
                    consume: vec!["kv".into()],
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        };
        let requested = CapabilitySet {
            services: ServiceCapabilities {
                consume: vec!["kv".into(), "other".into()],
                ..Default::default()
            },
            ..Default::default()
        };
        let audit = Arc::new(crate::audit::AuditSink::new(8));
        let gate = CapabilityGate::with_audit(&policy, audit.clone(), "slot-a", "plugin-a");
        gate.resolve(&policy, &requested);

        assert!(gate.require_service_consume("kv").is_ok());
        assert!(gate.require_service_consume("other").is_err());

        let events = audit.snapshot();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].decision, crate::audit::AuditDecision::Allow);
        assert_eq!(events[0].capability, "services.consume");
        assert_eq!(events[0].target, "kv");
        assert_eq!(events[1].decision, crate::audit::AuditDecision::Deny);
        assert_eq!(events[1].target, "other");
        assert!(events[1]
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("permission denied"));
    }
}
