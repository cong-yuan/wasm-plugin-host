//! Plugin configuration — the *desired state* the host reconciles toward.
//!
//! JSON (consistent with dsh's `dsh.json` convention). A `plugins.json` might
//! look like:
//!
//! ```json
//! {
//!   "watch": { "enabled": true, "interval_ms": 400 },
//!   "plugins": {
//!     "hello":  { "path": "target/wasm32-wasip1/release/hello_rust.wasm", "enabled": true },
//!     "greeter":{ "path": "plugins/greet.wasm", "enabled": false }
//!   }
//! }
//! ```
//!
//! The *key* is the **slot**: a stable identity that survives a plugin being
//! rebuilt or even renamed internally, so hot-reload can target it reliably.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

fn yes() -> bool {
    true
}
fn default_interval() -> u64 {
    400
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub plugins: BTreeMap<String, PluginEntry>,
    #[serde(default)]
    pub watch: Watch,
    /// Optional on-disk precompiled-module cache (`.cwasm`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<CacheConfig>,
    /// Minimum log level retained: `"debug" | "info" | "warn" | "error"`.
    /// Default `"debug"` (keep everything).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
}

/// Build-cache settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheConfig {
    /// Cache directory (relative paths resolve against the config's dir).
    pub dir: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            plugins: BTreeMap::new(),
            watch: Watch::default(),
            cache: None,
            log_level: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginEntry {
    /// Path to the `.wasm`, relative to the config file's directory.
    pub path: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Per-plugin override for auto-reload; defaults to the global `watch.enabled`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch: Option<bool>,
    /// Arbitrary JSON handed to the plugin at load (via `plugin_configure`)
    /// and readable at any time via the `host.get_config` import.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<serde_json::Value>,
    /// What to do when this entry's `config` changes at runtime:
    /// * `false` (default) — push the new config to the running instance live;
    ///   the plugin sees it via `host.get_config` / `plugin_on_config`.
    /// * `true` — reload the plugin so it re-reads the config from scratch.
    #[serde(default)]
    pub restart_on_config: bool,
}

impl PluginEntry {
    pub fn watching(&self, global: bool) -> bool {
        self.watch.unwrap_or(global)
    }

    /// The config value, or JSON `null` if unset.
    pub fn config_or_null(&self) -> &serde_json::Value {
        static NULL: serde_json::Value = serde_json::Value::Null;
        self.config.as_ref().unwrap_or(&NULL)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Watch {
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "default_interval")]
    pub interval_ms: u64,
}

impl Default for Watch {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_ms: default_interval(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading config {}", path.display()))?;
        let cfg: Config = serde_json::from_str(&text)
            .with_context(|| format!("parsing config {}", path.display()))?;
        Ok(cfg)
    }

    /// Load and then validate, surfacing *every* problem at once.
    ///
    /// `base` is the directory the config lives in; relative plugin paths and
    /// the cache dir are resolved against it, exactly as the supervisor does,
    /// so path-existence checks are accurate.
    pub fn load_validated(path: &Path) -> Result<Self> {
        let cfg = Self::load(path)?;
        let base = path.parent().unwrap_or_else(|| Path::new("."));
        let issues = cfg.validate(base);
        if !issues.is_empty() {
            let joined = issues
                .iter()
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join("\n  - ");
            anyhow::bail!("config {} has {} problem(s):\n  - {}", path.display(), issues.len(), joined);
        }
        Ok(cfg)
    }

    /// Validate the config, returning one [`ValidationIssue`] per problem
    /// (empty means valid). Checks are conservative: they catch the mistakes
    /// that would otherwise be *silently* ignored (a path that does not exist,
    /// a misspelled log level, an unknown enum value).
    pub fn validate(&self, base: &Path) -> Vec<ValidationIssue> {
        let mut issues = Vec::new();

        // Global log level, if present.
        if let Some(level) = &self.log_level {
            if crate::state::LogLevel::parse(level).is_none() {
                issues.push(ValidationIssue::new(
                    "log_level",
                    format!(
                        "unknown level `{level}` (expected debug | info | warn | error)"
                    ),
                ));
            }
        }

        // Cache dir: must be an absolute path or one we can resolve; we only
        // check it is not empty, since it is created on demand.
        if let Some(cache) = &self.cache {
            if cache.enabled && cache.dir.trim().is_empty() {
                issues.push(ValidationIssue::new("cache.dir", "must not be empty when enabled"));
            }
        }

        if self.watch.interval_ms == 0 {
            issues.push(ValidationIssue::new(
                "watch.interval_ms",
                "must be greater than 0 (a 0 interval busy-polls)",
            ));
        }

        // Per-plugin checks.
        for (slot, entry) in &self.plugins {
            if slot.trim().is_empty() {
                issues.push(ValidationIssue::new("plugins.<empty>", "slot name must not be empty"));
            }
            let field = format!("plugins.{slot}");
            if entry.path.trim().is_empty() {
                issues.push(ValidationIssue::new(
                    format!("{field}.path"),
                    "must not be empty",
                ));
                continue;
            }
            // Only check existence for *enabled* plugins: a disabled entry is
            // allowed to point at a not-yet-built artifact.
            if entry.enabled {
                let resolved = resolve_under(base, &entry.path);
                if !resolved.exists() {
                    issues.push(ValidationIssue::new(
                        format!("{field}.path"),
                        format!("file not found: {}", resolved.display()),
                    ));
                } else if resolved.extension().and_then(|e| e.to_str()) != Some("wasm") {
                    issues.push(ValidationIssue::new(
                        format!("{field}.path"),
                        format!("expected a .wasm file, got {}", resolved.display()),
                    ));
                }
            }
        }

        issues
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let text = serde_json::to_string_pretty(self)?;
        std::fs::write(path, format!("{text}\n"))
            .with_context(|| format!("writing config {}", path.display()))?;
        Ok(())
    }
}

/// One configuration problem, tagged with the field that caused it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    /// Dotted path to the offending field, e.g. `plugins.greet.path`.
    pub field: String,
    pub message: String,
}

impl ValidationIssue {
    pub fn new(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ValidationIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.field, self.message)
    }
}

/// Resolve a possibly-relative path against a base directory, the same way the
/// supervisor resolves plugin paths.
fn resolve_under(base: &Path, path: &str) -> std::path::PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.join(p)
    }
}
