//! `plugin-host` — a dsh-style WASM plugin host with a live supervisor.
//!
//! Runtime commands:
//!   load <slot> <path.wasm>     load a wasm into a slot
//!   unload <slot>               shutdown + drop a slot
//!   reload <slot>               hot-reload a slot from its wasm (atomic)
//!   enable <slot> / disable <slot>   adjust desired state, persist to config
//!   reconcile                   apply config desired state now
//!   refresh                     clear the compile caches (memory + disk)
//!   cache                       show disk compile-cache stats
//!   watch [on|off]              toggle the file watcher (hot reload)
//!   plugins / tools / call <tool> <json>
//!   config                      show the loaded config
//!   help / quit
//!
//! CLI:
//!   plugin-host                      interactive REPL
//!   plugin-host --config c.json      REPL bound to a config
//!   plugin-host --config c.json --supervise   run the watcher loop (no REPL)

use anyhow::Result;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use wasm_plugin_host::registry::Registry;
use wasm_plugin_host::runtime::Runtime;
use wasm_plugin_host::supervisor::{render, Supervisor};

fn rss_kb() -> u64 {
    let out = match std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
    {
        Ok(o) => o,
        Err(_) => return 0,
    };
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

struct Host {
    reg: Registry,
    sup: Option<Supervisor>,
    watching: bool,
}

fn main() -> Result<()> {
    let argv: Vec<String> = std::env::args().skip(1).collect();

    // Parse a couple of top-level flags.
    let mut config_path: Option<PathBuf> = None;
    let mut supervise = false;
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--config" | "-c" => {
                i += 1;
                config_path = argv.get(i).map(PathBuf::from);
            }
            "--supervise" | "--watch" => supervise = true,
            other => rest.push(other.to_string()),
        }
        i += 1;
    }

    // Load the config (if any) *before* building the runtime, so the runtime
    // can honour the config's compile-cache settings.
    let sup = match &config_path {
        Some(cp) => Some(Supervisor::new(cp)?),
        None => None,
    };

    let cache_dir = sup
        .as_ref()
        .and_then(|s| s.config.cache.as_ref())
        .filter(|c| c.enabled)
        .map(|c| {
            let p = std::path::Path::new(&c.dir);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                // Relative dirs resolve against the config file's directory,
                // matching how plugin paths are resolved.
                config_path
                    .as_ref()
                    .and_then(|cp| cp.parent().map(|d| d.join(p)))
                    .unwrap_or_else(|| p.to_path_buf())
            }
        });

    let runtime = match cache_dir {
        Some(dir) => Runtime::new_cached(dir)?,
        None => Runtime::new()?,
    };
    let mut host = Host {
        reg: Registry::new(runtime),
        sup: None,
        watching: false,
    };

    if let Some(sup) = sup {
        host.watching = sup.config.watch.enabled;
        host.sup = Some(sup);
    }

    if supervise {
        let sup = host
            .sup
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("--supervise requires --config <file>"))?;
        // Initial reconcile, then watch.
        for e in sup.reconcile(&mut host.reg) {
            println!("{}", render(&e));
        }
        let interval = sup.interval();
        // Prefer a real filesystem watcher; fall back to an mtime poll loop if
        // the platform watcher could not be created (e.g. no dirs existed yet).
        let watcher = sup.watcher()?;
        match &watcher {
            Some(_) => println!(
                "supervising {} (notify watcher); Ctrl-C to stop",
                sup.config_path().display()
            ),
            None => println!(
                "supervising {} (mtime poll {:?}); Ctrl-C to stop",
                sup.config_path().display(),
                interval
            ),
        }
        loop {
            // Block until a change event, or until the fallback elapses. The
            // fallback still matters: a plugin file may appear that did not
            // exist when the watcher was built.
            let woke = match &watcher {
                Some(w) => w.wait(interval),
                None => {
                    std::thread::sleep(interval);
                    false
                }
            };
            let _ = woke;
            let sup = host.sup.as_mut().unwrap();
            if host.watching {
                for e in sup.poll_changes(&mut host.reg) {
                    println!("{}", render(&e));
                }
            }
        }
    }

    if rest.is_empty() {
        return repl(&mut host);
    }
    run_command(&mut host, &rest).map(|_| ())
}

fn repl(host: &mut Host) -> Result<()> {
    println!("wasm-plugin-host — `help` for commands, `quit` to exit");
    if let Some(sup) = &host.sup {
        println!("config: {}  watching: {}", sup.config_path().display(), host.watching);
    }
    let stdin = std::io::stdin();
    // If the watcher is on, run a lightweight check before each prompt.
    loop {
        if host.watching {
            if let Some(sup) = host.sup.as_mut() {
                for e in sup.poll_changes(&mut host.reg) {
                    println!("{}", render(&e));
                }
            }
        }
        print!("host> ");
        std::io::stdout().flush()?;
        let mut line = String::new();
        if stdin.lock().read_line(&mut line)? == 0 {
            break;
        }
        let parts = tokenize(line.trim());
        if parts.is_empty() {
            continue;
        }
        if parts[0] == "quit" || parts[0] == "exit" {
            break;
        }
        if let Err(e) = run_command(host, &parts) {
            eprintln!("error: {e:#}");
        }
    }
    Ok(())
}

/// Split on whitespace, but keep a trailing JSON argument intact.
fn tokenize(line: &str) -> Vec<String> {
    let line = line.trim();
    if line.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    let mut rest = line;
    for _ in 0..2 {
        if let Some(i) = rest.find(char::is_whitespace) {
            out.push(rest[..i].to_string());
            rest = rest[i..].trim_start();
        } else {
            out.push(rest.to_string());
            return out;
        }
    }
    if !rest.is_empty() {
        out.push(rest.to_string());
    }
    out
}

fn run_command(host: &mut Host, parts: &[String]) -> Result<()> {
    // Sync with the filesystem before executing anything, so a rebuild that
    // landed while the user was typing is applied before their next command
    // runs. This is what makes reload *live* rather than merely periodic.
    if host.watching {
        if let Some(sup) = host.sup.as_mut() {
            for e in sup.poll_changes(&mut host.reg) {
                println!("{}", render(&e));
            }
        }
    }

    let reg = &mut host.reg;
    match parts[0].as_str() {
        "load" => {
            // Two forms: `load <path>` (slot from stem) or `load <slot> <path>`.
            let (slot, path) = match parts.len() {
                2 => {
                    let p = PathBuf::from(&parts[1]);
                    let s = p
                        .file_stem()
                        .map(|x| x.to_string_lossy().to_string())
                        .unwrap_or_else(|| "plugin".into());
                    (s, p)
                }
                3 => (parts[1].clone(), PathBuf::from(&parts[2])),
                _ => anyhow::bail!("usage: load <slot> <path.wasm>"),
            };
            let t = Instant::now();
            // If a config is loaded, take this slot's config from it; otherwise
            // pass JSON null.
            let cfg = host
                .sup
                .as_ref()
                .and_then(|s| s.config.plugins.get(&slot))
                .and_then(|e| e.config.clone())
                .unwrap_or(serde_json::Value::Null);
            let r = reg.load(&slot, &path, cfg)?;
            println!(
                "loaded slot `{}` -> plugin `{}` (state {:?}) in {:?}",
                r.slot, r.plugin, r.status, t.elapsed()
            );
            println!("  tools: {}", r.tools.join(", "));
        }
        "unload" => {
            let slot = parts.get(1).ok_or_else(|| anyhow::anyhow!("usage: unload <slot>"))?;
            let t = Instant::now();
            let removed = reg.unload(slot)?;
            println!("unloaded `{slot}` in {:?}; removed tools: {}", t.elapsed(),
                if removed.is_empty() { "(none)".into() } else { removed.join(", ") });
        }
        "reload" => {
            let slot = parts.get(1).ok_or_else(|| anyhow::anyhow!("usage: reload <slot>"))?;
            let t = Instant::now();
            match host.sup.as_mut() {
                Some(sup) => {
                    let e = sup.reload_slot(reg, slot)?;
                    println!("{} ({:?})", render(&e), t.elapsed());
                }
                None => {
                    // No config: reload from the path the slot was loaded from,
                    // keeping the current config.
                    let path = reg
                        .slot_path(slot)
                        .ok_or_else(|| anyhow::anyhow!("no such slot `{slot}` and no config"))?;
                    let r = reg.reload(slot, &path, None)?;
                    println!(
                        "reloaded `{}`: [{}] -> [{}] ({:?})",
                        r.slot, r.old_tools.join(", "), r.new_tools.join(", "), t.elapsed()
                    );
                }
            }
        }
        "enable" | "disable" => {
            let slot = parts.get(1).ok_or_else(|| anyhow::anyhow!("usage: {0} <slot>", parts[0]))?;
            let on = parts[0] == "enable";
            let sup = host.sup.as_mut().ok_or_else(|| anyhow::anyhow!("no config loaded (use --config)"))?;
            sup.set_enabled(slot, on)?;
            for e in sup.reconcile(reg) {
                println!("{}", render(&e));
            }
            println!("`{slot}` {}", if on { "enabled" } else { "disabled" });
        }
        "reconcile" => {
            let sup = host.sup.as_mut().ok_or_else(|| anyhow::anyhow!("no config loaded (use --config)"))?;
            for e in sup.reconcile(reg) {
                println!("{}", render(&e));
            }
        }
        "set-config" | "setconfig" => {
            // set-config <slot> '<json>'   -- persists and applies to that slot only
            let slot = parts.get(1).ok_or_else(|| anyhow::anyhow!("usage: set-config <slot> '<json>'"))?;
            let json = parts.get(2).ok_or_else(|| anyhow::anyhow!("usage: set-config <slot> '<json>'"))?;
            let value: serde_json::Value = serde_json::from_str(json)
                .map_err(|e| anyhow::anyhow!("bad JSON: {e}"))?;
            let sup = host.sup.as_mut().ok_or_else(|| anyhow::anyhow!("no config loaded (use --config)"))?;
            sup.set_config(slot, value)?;
            for e in sup.reconcile(reg) {
                println!("{}", render(&e));
            }
        }
        "reconfig" | "reload-config" => {
            let sup = host.sup.as_mut().ok_or_else(|| anyhow::anyhow!("no config loaded (use --config)"))?;
            sup.reload_config()?;
            println!("config reloaded from {}", sup.config_path().display());
            for e in sup.reconcile(reg) {
                println!("{}", render(&e));
            }
        }
        "refresh" => {
            reg.runtime().clear_cache();
            let removed = reg.runtime().clear_disk_cache().unwrap_or(0);
            if removed > 0 {
                println!("compile cache cleared ({removed} disk artifact(s))");
            } else {
                println!("compile cache cleared");
            }
        }
        "cache" => {
            let s = reg.runtime().cache_stats();
            println!(
                "disk cache: {} | hits {} misses {} writes {} errors {}",
                if reg.runtime().disk_cache_enabled() { "enabled" } else { "disabled" },
                s.hits, s.misses, s.writes, s.errors
            );
        }
        "watch" => {
            match parts.get(1).map(|s| s.as_str()) {
                Some("on") => host.watching = true,
                Some("off") => host.watching = false,
                _ => {
                    println!("watching: {}", host.watching);
                    return Ok(());
                }
            }
            println!("watching: {}", host.watching);
        }
        "plugins" => {
            let v = reg.list_plugins();
            if v.is_empty() {
                println!("  (none)");
            }
            for (slot, plugin, state, n, active) in v {
                println!(
                    "  slot={slot}  plugin={plugin}  state={state:?}  tools={n}{}",
                    if active { "" } else { "  (quiescent: unmet injects)" }
                );
            }
        }
        "tools" => {
            for t in reg.list_tools() {
                println!("  {}  (slot {})  {}", t.name, t.slot, t.description);
            }
        }
        "call" | "run" => {
            let tool = parts.get(1).ok_or_else(|| anyhow::anyhow!("usage: call <tool> '<json>'"))?;
            let args_json = parts.get(2).map(|s| s.as_str()).unwrap_or("{}");
            let args: serde_json::Value = serde_json::from_str(args_json)
                .map_err(|e| anyhow::anyhow!("bad JSON args: {e}"))?;
            let t = Instant::now();
            let out = reg.call_tool(tool, &args)?;
            println!("{}", serde_json::to_string_pretty(&out)?);
            eprintln!("({:?})", t.elapsed());
        }
        "logs" => {
            // logs [slot] [n]   -- show buffered plugin logs (newest last)
            let recs = match parts.get(1) {
                Some(slot) => reg.logs_for(slot),
                None => reg.logs(),
            };
            let n: usize = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(usize::MAX);
            let start = recs.len().saturating_sub(n);
            if recs.is_empty() {
                println!("  (no logs buffered)");
            }
            for r in &recs[start..] {
                println!("  #{:<5} {}", r.seq, r.render());
            }
            println!("  -- {} record(s), buffer cap {}", reg.log_sink().len(), reg.log_sink().capacity());
        }
        "clear-logs" => {
            reg.log_sink().clear();
            println!("log buffer cleared");
        }
        "status" => {
            println!("memory: {} KB", rss_kb());
            println!("plugins: {}", reg.list_plugins().len());
            println!("tools: {}", reg.list_tools().len());
            println!("log records: {} (cap {})", reg.log_sink().len(), reg.log_sink().capacity());
            println!("watching: {}", host.watching);
            if let Some(sup) = &host.sup {
                println!("config: {}", sup.config_path().display());
            }
        }
        "config" => match &host.sup {
            Some(sup) => println!("{}", serde_json::to_string_pretty(&sup.config)?),
            None => println!("(no config loaded)"),
        },
        "help" => {
            println!("commands:");
            println!("  load <slot> <wasm> | unload <slot> | reload <slot>");
            println!("  enable <slot> | disable <slot> | reconcile | reconfig | refresh");
            println!("  watch [on|off] | plugins | tools | call <tool> <json>");
            println!("  logs [slot] [n] | clear-logs | status | config | quit");
        }
        other => anyhow::bail!("unknown command: {other}"),
    }
    Ok(())
}

#[allow(dead_code)]
fn _keep(_: Duration) {}
