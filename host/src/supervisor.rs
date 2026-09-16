//! `Supervisor` — keeps the running host in sync with a config file and a
//! directory of `.wasm` files.
//!
//! Responsibilities:
//! * **Reconcile** the registry toward the config's desired state (load what
//!   should be loaded, unload what shouldn't).
//! * **Watch** each enabled plugin's wasm for mtime changes (i.e. a rebuild)
//!   and hot-reload it — atomically, so a broken build never takes the host
//!   down.
//! * **Diff config per plugin** and only touch the plugins whose config actually
//!   changed — either pushing the new value live, or restarting just that one.
//! * **Persist** enable/disable back into the config so intent survives restart.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use crate::config::Config;
use crate::registry::Registry;
use notify::Watcher as _;

/// A single line of reconciliation output, for logging/progress.
#[derive(Debug)]
pub enum Event {
    Loaded { slot: String, tools: Vec<String> },
    Unloaded { slot: String, tools: Vec<String> },
    Reloaded { slot: String, old: Vec<String>, new: Vec<String> },
    ReloadFailed { slot: String, error: String },
    LoadFailed { slot: String, error: String },
    /// A slot's config changed and was pushed live (no restart).
    ConfigUpdated { slot: String },
    /// A slot's config changed and the plugin was restarted to pick it up.
    ConfigRestarted { slot: String },
    /// A slot's config changed live but the plugin has no `plugin_on_config`
    /// hook — it will see the new value on its next `host.get_config` pull.
    ConfigUpdatedPullOnly { slot: String },
    ConfigUpdateFailed { slot: String, error: String },
    /// Config referenced a file that does not exist yet (waiting for a build).
    Missing { slot: String, path: PathBuf },
}

pub struct Supervisor {
    config_path: PathBuf,
    /// Directory the config's relative paths resolve against.
    base_dir: PathBuf,
    pub config: Config,
    /// slot -> last seen mtime of its wasm
    mtimes: HashMap<String, u128>,
    /// Last seen mtime of the config file itself, so external edits are picked
    /// up and each plugin's config is diffed.
    config_mtime: u128,
}

impl Supervisor {
    pub fn new(config_path: &Path) -> Result<Self> {
        let config_path = config_path
            .canonicalize()
            .unwrap_or_else(|_| config_path.to_path_buf());
        let base_dir = config_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        let config = if config_path.exists() {
            Config::load(&config_path)?
        } else {
            Config::default()
        };
        let config_mtime = if config_path.exists() {
            mtime_ns(&config_path)
        } else {
            0
        };
        Ok(Self {
            config_path,
            base_dir,
            config,
            mtimes: HashMap::new(),
            config_mtime,
        })
    }

    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    /// Resolve a config-relative path.
    pub fn resolve(&self, p: &str) -> PathBuf {
        let path = Path::new(p);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.base_dir.join(path)
        }
    }

    /// Bring the registry to match the config. Returns the events applied.
    ///
    /// For already-loaded slots this also diffs the config **per slot** and
    /// applies only the changes — so an edit to one plugin's config never
    /// disturbs the others.
    pub fn reconcile(&mut self, reg: &mut Registry) -> Vec<Event> {
        let mut events = Vec::new();

        // Desired sets: slot -> (path, enabled, config, restart_on_config).
        #[derive(Clone)]
        struct Desired {
            path: PathBuf,
            enabled: bool,
            config: serde_json::Value,
            restart_on_config: bool,
        }
        let desired: HashMap<String, Desired> = self
            .config
            .plugins
            .iter()
            .map(|(slot, e)| {
                (
                    slot.clone(),
                    Desired {
                        path: self.resolve(&e.path),
                        enabled: e.enabled,
                        config: e.config.clone().unwrap_or(serde_json::Value::Null),
                        restart_on_config: e.restart_on_config,
                    },
                )
            })
            .collect();

        // Unload anything loaded but not desired-enabled.
        let loaded: Vec<String> = reg.list_plugins().iter().map(|(s, ..)| s.to_string()).collect();
        for slot in loaded {
            let keep = desired.get(&slot).map(|d| d.enabled).unwrap_or(false);
            if !keep {
                match reg.unload(&slot) {
                    Ok(tools) => {
                        self.mtimes.remove(&slot);
                        events.push(Event::Unloaded { slot, tools });
                    }
                    Err(e) => events.push(Event::LoadFailed { slot, error: e.to_string() }),
                }
            }
        }

        // Load anything desired-enabled but not loaded; update config on the
        // ones already loaded.
        for (slot, d) in &desired {
            if !d.enabled {
                continue;
            }
            if !reg.is_loaded(slot) {
                if !d.path.exists() {
                    events.push(Event::Missing { slot: slot.clone(), path: d.path.clone() });
                    continue;
                }
                match reg.load(slot, &d.path, d.config.clone()) {
                    Ok(r) => {
                        self.mtimes.insert(slot.clone(), mtime_ns(&d.path));
                        events.push(Event::Loaded { slot: slot.clone(), tools: r.tools });
                    }
                    Err(e) => {
                        events.push(Event::LoadFailed { slot: slot.clone(), error: e.to_string() })
                    }
                }
            } else if let Some(ev) =
                self.apply_config_if_changed(reg, slot, &d.config, d.restart_on_config, &d.path)
            {
                events.push(ev);
            }
        }

        events
    }

    /// Hot-reload any enabled plugin whose wasm mtime changed since we last saw
    /// it, and apply config changes to any plugin whose config differs.
    ///
    /// Both checks are **per plugin**: an unchanged plugin is never restarted,
    /// reloaded, or even re-configured.
    pub fn poll_changes(&mut self, reg: &mut Registry) -> Vec<Event> {
        let mut events = Vec::new();
        let watch_global = self.config.watch.enabled;

        // If the config *file itself* changed (edited externally), reload it so
        // the per-plugin diffs below see the new values. Reloading the file is
        // not the same as applying it: only slots whose config actually differs
        // are touched.
        if self.config_path.exists() {
            let now = mtime_ns(&self.config_path);
            if now != self.config_mtime {
                match Config::load(&self.config_path) {
                    Ok(cfg) => {
                        self.config = cfg;
                        self.config_mtime = now;
                    }
                    Err(e) => {
                        // Keep the last good config if the edit is malformed.
                        self.config_mtime = now;
                        events.push(Event::ConfigUpdateFailed {
                            slot: "<config>".to_string(),
                            error: format!("config file parse error, keeping previous: {e}"),
                        });
                    }
                }
            }
        }

        // Snapshot the entries we care about up front.
        struct Want {
            slot: String,
            path: PathBuf,
            config: serde_json::Value,
            restart_on_config: bool,
            watch: bool,
        }
        let wants: Vec<Want> = self
            .config
            .plugins
            .iter()
            .filter(|(_, e)| e.enabled)
            .map(|(slot, e)| Want {
                slot: slot.clone(),
                path: self.resolve(&e.path),
                config: e.config.clone().unwrap_or(serde_json::Value::Null),
                restart_on_config: e.restart_on_config,
                watch: e.watching(watch_global),
            })
            .collect();

        for w in wants {
            // --- config diff first: independent of whether the wasm changed ---
            if reg.is_loaded(&w.slot) {
                if let Some(ev) = self.apply_config_if_changed(
                    reg,
                    &w.slot,
                    &w.config,
                    w.restart_on_config,
                    &w.path,
                ) {
                    events.push(ev);
                }
            }

            // --- wasm rebuild? ---
            if !w.watch {
                continue;
            }
            if !w.path.exists() {
                continue;
            }
            let now = mtime_ns(&w.path);
            let last = self.mtimes.get(&w.slot).copied();
            match last {
                // No baseline yet (e.g. loaded manually): adopt the current
                // mtime rather than fire a spurious reload on the first tick.
                None => {
                    if reg.is_loaded(&w.slot) {
                        self.mtimes.insert(w.slot, now);
                        continue;
                    }
                }
                Some(prev) if prev == now => continue, // unchanged
                _ => {}
            }

            if !reg.is_loaded(&w.slot) {
                match reg.load(&w.slot, &w.path, w.config.clone()) {
                    Ok(r) => {
                        self.mtimes.insert(w.slot.clone(), now);
                        events.push(Event::Loaded { slot: w.slot, tools: r.tools });
                    }
                    Err(e) => {
                        // Record the mtime even on failure so a bad build or a
                        // tool collision is not retried every tick; it will be
                        // retried once the file changes again.
                        self.mtimes.insert(w.slot.clone(), now);
                        events.push(Event::LoadFailed { slot: w.slot, error: e.to_string() });
                    }
                }
                continue;
            }

            // Already loaded and mtime changed -> atomic reload (new wasm, and
            // re-apply the *current* config so a rebuild never loses it).
            match reg.reload(&w.slot, &w.path, Some(w.config.clone())) {
                Ok(r) => {
                    self.mtimes.insert(w.slot.clone(), now);
                    events.push(Event::Reloaded {
                        slot: r.slot,
                        old: r.old_tools,
                        new: r.new_tools,
                    });
                }
                Err(e) => {
                    // Record the new mtime so we don't retry a broken build every
                    // tick; the old plugin stays live meanwhile.
                    self.mtimes.insert(w.slot.clone(), now);
                    events.push(Event::ReloadFailed { slot: w.slot, error: e.to_string() });
                }
            }
        }

        events
    }

    /// If `desired` differs from what the slot currently has applied, apply it
    /// — live, or by restarting the plugin, per `restart_on_config`. Returns an
    /// event only when something actually changed.
    fn apply_config_if_changed(
        &mut self,
        reg: &mut Registry,
        slot: &str,
        desired: &serde_json::Value,
        restart_on_config: bool,
        path: &Path,
    ) -> Option<Event> {
        let current = reg.slot_config(slot);
        if current == Some(desired) {
            return None; // unchanged -> touch nothing
        }

        if restart_on_config {
            // Restart just this plugin so it re-reads the config from scratch.
            match reg.reload(slot, path, Some(desired.clone())) {
                Ok(_) => Some(Event::ConfigRestarted { slot: slot.to_string() }),
                Err(e) => Some(Event::ConfigUpdateFailed { slot: slot.to_string(), error: e.to_string() }),
            }
        } else {
            match reg.apply_config(slot, desired.clone()) {
                Ok(true) => Some(Event::ConfigUpdated { slot: slot.to_string() }),
                Ok(false) => Some(Event::ConfigUpdatedPullOnly { slot: slot.to_string() }),
                Err(e) => Some(Event::ConfigUpdateFailed { slot: slot.to_string(), error: e.to_string() }),
            }
        }
    }

    /// Manually reload one slot from its configured path (re-applying its
    /// current config).
    pub fn reload_slot(&mut self, reg: &mut Registry, slot: &str) -> Result<Event> {
        let entry = self
            .config
            .plugins
            .get(slot)
            .ok_or_else(|| anyhow::anyhow!("slot `{slot}` is not in the config"))?;
        let path = self.resolve(&entry.path);
        let cfg = entry.config.clone().unwrap_or(serde_json::Value::Null);
        let r = reg.reload(slot, &path, Some(cfg))?;
        self.mtimes.insert(slot.to_string(), mtime_ns(&path));
        Ok(Event::Reloaded { slot: r.slot, old: r.old_tools, new: r.new_tools })
    }

    /// Enable/disable a slot and persist the change.
    pub fn set_enabled(&mut self, slot: &str, enabled: bool) -> Result<()> {
        let entry = self
            .config
            .plugins
            .get_mut(slot)
            .ok_or_else(|| anyhow::anyhow!("slot `{slot}` is not in the config"))?;
        entry.enabled = enabled;
        self.config.save(&self.config_path)
    }

    /// Replace a slot's config in the file and persist (used by `set-config`).
    pub fn set_config(&mut self, slot: &str, config: serde_json::Value) -> Result<()> {
        let entry = self
            .config
            .plugins
            .get_mut(slot)
            .ok_or_else(|| anyhow::anyhow!("slot `{slot}` is not in the config"))?;
        entry.config = Some(config);
        self.config.save(&self.config_path)
    }

    /// Reload the config file from disk (e.g. after external edit).
    pub fn reload_config(&mut self) -> Result<()> {
        self.config = Config::load(&self.config_path)?;
        self.config_mtime = if self.config_path.exists() {
            mtime_ns(&self.config_path)
        } else {
            0
        };
        Ok(())
    }

    pub fn interval(&self) -> Duration {
        Duration::from_millis(self.config.watch.interval_ms.max(50))
    }

    /// Build a filesystem watcher over this config's plugin files.
    ///
    /// Returns `None` if watching is disabled in the config. The watcher emits
    /// on a channel whenever a watched `.wasm` **or the config file itself**
    /// changes, so the caller can call [`Supervisor::poll_changes`] only when
    /// something actually happened — instead of sleeping and re-stat'ing on a
    /// timer.
    pub fn watcher(&self) -> Result<Option<Watcher>> {
        if !self.config.watch.enabled {
            return Ok(None);
        }
        let mut paths: Vec<PathBuf> = self
            .config
            .plugins
            .values()
            .map(|e| self.resolve(&e.path))
            .collect();
        paths.push(self.config_path.clone());
        Watcher::new(&paths)
    }
}

fn mtime_ns(path: &Path) -> u128 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_nanos())
        .unwrap_or(0)
}

/// A filesystem watcher wrapping `notify`, exposing a blocking `recv` that fires
/// when any watched file changes.
///
/// It watches the **parent directories** of the target files rather than the
/// files themselves, because many editors and build tools replace files
/// atomically (write-temp + rename), which would otherwise drop the watch. A
/// small debounce coalesces the burst of events a single save produces, and a
/// fallback timeout lets the caller still poll occasionally (e.g. for a file
/// that did not exist when the watcher started, then appeared).
pub struct Watcher {
    _inner: notify::RecommendedWatcher,
    rx: std::sync::mpsc::Receiver<()>,
    debounce: Duration,
}

impl Watcher {
    /// Watch the directories containing `paths`, plus `paths` themselves if they
    /// exist. Call [`Watcher::wait`] to block for the next change.
    pub fn new(paths: &[PathBuf]) -> Result<Option<Self>> {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let tx = std::sync::Mutex::new(tx);

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                use notify::EventKind::*;
                if matches!(event.kind, Create(_) | Modify(_) | Remove(_) | Any) {
                    // Best-effort: a full or disconnected channel just means the
                    // consumer is going away.
                    let _ = tx.lock().map(|t| t.send(()));
                }
            }
        })
        .map_err(|e| anyhow::anyhow!("creating filesystem watcher: {e}"))?;

        // Watch parent dirs (survives atomic replace); also watch existing files
        // directly so we get events even on platforms with coarse dir events.
        let mut dirs: Vec<PathBuf> = Vec::new();
        for p in paths {
            if let Some(dir) = p.parent() {
                if !dirs.contains(&dir.to_path_buf()) {
                    dirs.push(dir.to_path_buf());
                }
            }
        }
        let mut watched_any = false;
        for dir in &dirs {
            if dir.exists() {
                if watcher
                    .watch(dir, notify::RecursiveMode::NonRecursive)
                    .is_ok()
                {
                    watched_any = true;
                }
            }
        }
        for p in paths {
            if p.exists()
                && watcher
                    .watch(p, notify::RecursiveMode::NonRecursive)
                    .is_ok()
            {
                watched_any = true;
            }
        }
        if !watched_any {
            return Ok(None);
        }

        Ok(Some(Self {
            _inner: watcher,
            rx,
            debounce: Duration::from_millis(80),
        }))
    }

    /// Block until a change is seen, or until the fallback interval elapses.
    /// Returns `true` if a change was observed, `false` on timeout.
    pub fn wait(&self, fallback: Duration) -> bool {
        let first = if fallback.is_zero() {
            self.rx.recv().map_err(|_| ())
        } else {
            self.rx.recv_timeout(fallback).map_err(|_| ())
        };
        if first.is_err() {
            return false; // timeout or disconnected
        }
        // Debounce: drain any further events that arrive within the window.
        let deadline = std::time::Instant::now() + self.debounce;
        loop {
            let now = std::time::Instant::now();
            if now >= deadline {
                break;
            }
            match self.rx.recv_timeout(deadline - now) {
                Ok(()) => continue,
                Err(_) => break,
            }
        }
        true
    }
}

/// Convenience: does the path exist and look like a wasm file?
pub fn looks_like_wasm(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.is_file()).unwrap_or(false)
        && path.extension().map(|e| e == "wasm").unwrap_or(false)
}

/// Format an event for the terminal.
pub fn render(e: &Event) -> String {
    match e {
        Event::Loaded { slot, tools } => {
            format!("loaded `{slot}` -> tools [{}]", tools.join(", "))
        }
        Event::Unloaded { slot, tools } => {
            format!("unloaded `{slot}` (removed tools: {})", tools.join(", "))
        }
        Event::Reloaded { slot, old, new } => {
            format!("reloaded `{slot}`: [{}] -> [{}]", old.join(", "), new.join(", "))
        }
        Event::ReloadFailed { slot, error } => {
            format!("reload FAILED for `{slot}` (kept old): {error}")
        }
        Event::LoadFailed { slot, error } => format!("load FAILED for `{slot}`: {error}"),
        Event::ConfigUpdated { slot } => format!("config updated live for `{slot}`"),
        Event::ConfigUpdatedPullOnly { slot } => {
            format!("config updated for `{slot}` (plugin has no on_config hook; readable via host.get_config)")
        }
        Event::ConfigRestarted { slot } => format!("config changed -> restarted `{slot}`"),
        Event::ConfigUpdateFailed { slot, error } => {
            format!("config update FAILED for `{slot}`: {error}")
        }
        Event::Missing { slot, path } => format!("waiting for `{slot}` at {}", path.display()),
    }
}

/// Load a config, merging in any plugins discovered under `dir` (by `.wasm`).
pub fn discover(dir: &Path, cfg: &mut Config) -> Result<usize> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut found = 0;
    for entry in std::fs::read_dir(dir).context("reading plugin dir")? {
        let entry = entry?;
        let path = entry.path();
        if looks_like_wasm(&path) {
            let slot = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            cfg.plugins.entry(slot).or_insert_with(|| crate::config::PluginEntry {
                path: path.to_string_lossy().to_string(),
                enabled: false,
                watch: None,
                config: None,
                restart_on_config: false,
            });
            found += 1;
        }
    }
    Ok(found)
}
