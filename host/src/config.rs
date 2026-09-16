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

    pub fn save(&self, path: &Path) -> Result<()> {
        let text = serde_json::to_string_pretty(self)?;
        std::fs::write(path, format!("{text}\n"))
            .with_context(|| format!("writing config {}", path.display()))?;
        Ok(())
    }
}
