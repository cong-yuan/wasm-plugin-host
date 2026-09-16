# wasm-plugin-host

> **中文文档全套在 [`docs/`](docs/README.md)** — 需求 / 架构 / 使用指南 / 进度 / 计划 /
> 已知问题 / 测试 / ABI,从那里开始。

A **dsh-style WASM plugin host** with a live **supervisor**: plugins load and
unload at runtime, driven by **commands** or a **config file**, and a rebuilt
`.wasm` is **hot-swapped into the running process** — atomically, so a broken
build never takes the host down.

Unlike `dlopen`, dropping a WASM instance **really releases its code and
linear memory**.

Plugins are not just callable leaves — they **intervene in the agent flow**.
A plugin may subscribe to flow events (`agent/pre-step`, `tools/pre-execute`,
`assistant/chunk`, ...) and **observe, rewrite, or veto** what happens next. That is
the dsh model.

```
┌────────────────────────────────────────────────────────────┐
│  Supervisor   config (desired state) + notify watcher      │
│               reconcile · poll_changes · set_config         │
├────────────────────────────────────────────────────────────┤
│  Flow         run_turn: the loop plugins intervene in       │
│               dispatch(event, value) -> Dispatch            │
├────────────────────────────────────────────────────────────┤
│  Registry     slots · ATOMIC reload · hooks · services      │
│               load / unload / reload / call_tool / dispatch  │
├────────────────────────────────────────────────────────────┤
│  Plugin       lifecycle + tools + hooks + inject/provide    │
├────────────────────────────────────────────────────────────┤
│  Runtime      pooling/on-demand, compile cache, WASI, host.*│
└───────────────────┬────────────────────────────────────────┘
                    │ wasmtime
        ┌───────────┼───────────┬─────────────┐
        ▼           ▼           ▼             ▼
   hello-rust   hello-go    plain-rust    (future)
    .wasm        .wasm       .wasm      js / python
```

## Plugin participation (the dsh model)

A plugin's declaration says not only what tools it exposes, but **where it enters
the flow** and **what services it needs/provides**:

```json
{
  "name": "guard",
  "abi": 1,
  "tools": [],
  "hooks":   [ { "on": "tools/pre-execute", "exec": "check", "mode": "waterfall" } ],
  "injects": [ "sessions" ],
  "provides": [ "policy" ]
}
```

* **`hooks`** — subscribe to flow events. `mode: "observe"` sees the event but
  cannot change it; `mode: "waterfall"` returns a **decision**:
  `{"kind":"continue"}`, `{"kind":"rewrite","value":...}`, or
  `{"kind":"veto","reason":"..."}`. Waterfalls are chained — each subscriber
  sees the value as rewritten so far. A hook that errors or returns junk is
  **fail-open**: skipped, never wedging the flow.
* **`injects` / `provides`** — a service graph with **responsive convergence**.
  A plugin is *active* iff every service it injects is provided by an active
  plugin. Activating registers its tools/hooks/services, which can satisfy
  another plugin's injects — so a whole chain converges in one pass, and losing
  a provider cascades deactivation. A plugin with unmet injects loads but stays
  **quiescent** (its tools are not registered).
* **`host.call_service`** — a plugin calls another plugin **by service name**
  (capability), not by slot. Nested calls work; a recursive call fails with a
  clear "busy" error instead of deadlocking; a missing provider returns a JSON
  error rather than trapping.

### It really converges

`examples/services.rs`: load a consumer whose inject is unmet, then load its
provider and watch it activate, call across plugins, then unload and watch it
deactivate — all without restarting anything.

```
== load `report` first (injects kv, unmet) ==
  active=false  missing=["kv"]  tools=[]
  report_tool registered? false

== load `kv` (provides kv) -> cascade ==
  report now active? true
  report_tool registered? true

== call report_tool -> it calls the kv service ==
  {"content":"value-from-kv","kind":"success","value":{"k":"v"}}

== unload `kv` -> cascade deactivates report ==
  report active? false
  report_tool registered? false
```

### It really intervenes

`examples/intervene.rs` builds a WASM plugin that vetoes a tool call, runs a
turn, then unloads it and re-runs:

```
hooks registered: 2

--- turn 1 (guard active) ---
  vetoed: Some("guard")
  executed: 0           # the tool never ran

--- unloading guard ---

--- turn 2 (guard gone) ---
  vetoed: None
  executed: 1           # now it runs
  hooks still registered: 1
```

The host ships a minimal flow (`flow::run_turn`) so there is something to
intervene in: `turn/start → agent/pre-step → agent/request → model →
assistant/chunk → assistant/message → tool/* → turn/end`, each point dispatching the
matching event. A real host swaps `Model::complete` for a provider; the event
plumbing is what matters here.

## The feature: live load / unload / hot-reload

Three ways to drive the same machinery:

### 1. Commands (REPL)

```sh
$ plugin-host --config plugins.json
host> plugins
  slot=greet  plugin=hello-rust  state=Active  tools=2
host> reload greet                     # atomic hot-swap from its wasm
host> disable greet                    # unload + persist enabled:false
host> enable greet                     # load + persist enabled:true
host> reconcile                        # apply config desired state now
host> set-config greet '{"greeting":"Hi"}'   # change one plugin's config
host> logs                             # show buffered plugin logs
host> logs greet 20                    # just slot `greet`, last 20 lines
host> clear-logs
host> refresh                          # clear the compile cache
host> watch on|off
```

### 2. Config file (desired state)

```json
{
  "watch": { "enabled": true, "interval_ms": 300 },
  "plugins": {
    "greet": {
      "path": "target/wasm32-wasip1/release/hello_rust.wasm",
      "enabled": true,
      "config": { "greeting": "Hello" },
      "restart_on_config": false
    },
    "extra": { "path": "plugins/extra.wasm", "enabled": false }
  }
}
```

`reconcile` makes the running host match this: it loads everything `enabled`
and unloads everything else. `enable`/`disable` write back to the file, so
intent survives restart. Paths are relative to the config file.

### 2b. Config injection and live config updates

Each entry can carry a `config` object, delivered to the plugin two ways:

* **At load** — pushed into the plugin's state; if the plugin exports
  `plugin_configure`, that hook runs once and it reads the value via
  `host.get_config`.
* **At runtime** — when the entry's `config` changes, the supervisor diffs it
  against the value currently applied to that slot and updates **only that
  plugin**:
  * `restart_on_config: false` (default) → **live push**. The running instance
    gets the new config and `plugin_on_config` fires. No reload.
  * `restart_on_config: true` → **restart just this plugin**, so it re-reads
    its config from scratch.

```
config file edited ──▶ supervisor notices ──▶ per-slot diff
                                              ├─ greet.config changed  ──▶ update greet only
                                              └─ others unchanged      ──▶ untouched
```

Only the plugin whose `config` changed is ever touched. An edit to one plugin's
config never reloads or reconfigures the others — enforced by
`apply_config_if_changed` and covered by the test
`config_change_to_one_slot_leaves_the_other_untouched`.

Plugin-side read (Rust):

```rust
#[link(wasm_import_module = "host")]
unsafe extern "C" {
    fn get_config(out: *mut u8, cap: usize) -> i64;
    fn config_version() -> i64;   // bumped on every change
}
```

A plugin can also just poll: compare `host.config_version()` to its cached value
and call `host.get_config` only when it changed.

### 3. Daemon (file watcher)

```sh
$ plugin-host --config plugins.json --supervise
loaded `greet` -> tools [greet, echo_num]
supervising plugins.json (interval 300ms); Ctrl-C to stop
reloaded `greet`: [greet, echo_num] -> [greet, echo_num]
```

No input required — rebuilding the `.wasm` is enough. With interactive use, the
watcher is polled **before every command**, so a rebuild that lands while you
are typing is applied before your next command runs.

## The development loop this enables

```
edit plugin.rs  ──▶  cargo build -p my-plugin --target wasm32-wasip1
                                            │
                                            ▼
                        (overwrites the .wasm the config points at)
                                            │
                                            ▼
                     running host notices mtime change ──▶ hot-swaps
```

Run the demos:

```sh
./demo/hotreload.sh      # v1 output → rebuild → v2 output, host stays up
./demo/broken-build.sh   # corrupt the wasm → reload rejected, old keeps serving
./demo/config-live.sh    # edit ONE plugin's config → only THAT plugin updates
```

## Atomic reload (the important guarantee)

`Registry::reload` never tears down a working plugin to try a new one:

1. **Stage**: load + validate the new module into a detached `Plugin`
   (`plugin_init`, `plugin_describe`, ABI check, tool-collision check).
2. **Commit**: only if step 1 fully succeeds, shut down the old plugin, drop it
   (real memory release), and install the new one.

If the new build is broken — bad wasm, ABI mismatch, missing export, or a tool
name that collides with another slot — the error is reported and **the old
plugin keeps running**. Demonstrated in `demo/broken-build.sh` and covered by
`reload_is_atomic_on_broken_build`.

A **slot** is the stable identity (`"greet"`) that survives a plugin being
rebuilt or even renaming itself internally, so reload always has a target.

## Quick start

```sh
cargo build --release
cargo build --release -p hello-rust --target wasm32-wasip1   # rustup target add wasm32-wasip1

./target/release/plugin-host                                  # REPL, no config
./target/release/plugin-host --config demo/live.json          # REPL + watcher
./target/release/plugin-host --config demo/live.json --supervise   # daemon
cargo test --release                                          # 85 tests, hermetic
```

## Plugin logs

**Logging is language-agnostic: it uses WASI stdout/stderr, so any language's
normal print works with zero glue.**

| Language | what it writes |
|---|---|
| Rust | `println!` / `eprintln!` |
| Go | `fmt.Println` / `fmt.Fprintln(os.Stderr, ...)` |
| C | `printf` / `fprintf(stderr, ...)` |
| Zig | `std.debug.print` |
| JS (jco) | `console.log` / `console.error` |
| Python | `print()` / `sys.stderr.write` |

Each instance gets a custom `StdoutStream`/`StderrStream` that splits output
into lines and feeds a shared, bounded log sink. stdout → `Info`, stderr →
`Error`; a final line with no newline is flushed on drop.

```sh
host> logs
  #1     [greet] info:  hello from Go stdout
  #2     [greet] error: hello from Go stderr
  -- 2 record(s), buffer cap 1000
```

Every line becomes a `LogRecord { seq, slot, plugin, level, message }`, which is:

1. **stored in a bounded ring buffer** — default 1000 records, older ones
   dropped, so a chatty plugin can't grow memory without bound;
2. **echoed to stderr** as `[slot] level: message` (prefix is the *slot*, e.g.
   `[greet]` — not the file stem);
3. **passed to an optional `LogHook`** for every record.

`host.log(level, ptr, len)` remains available as an **optional structured
upgrade** for guests wanting an explicit level (e.g. `Warn`/`Debug`, which have
no separate WASI fd). Both channels feed the same sink.

From an embedding host (e.g. a Tauri backend) you can pull logs or subscribe to
new ones:

```rust
use wasm_plugin_host::{Registry, Runtime, LogHook, LogRecord};
use std::sync::Arc;

// Forward every plugin log line into your own sink / Tauri event.
let hook: LogHook = Arc::new(|rec: &LogRecord| {
    // e.g. app.emit("plugin-log", rec)?;
    println!("{} #{}", rec.render(), rec.seq);
});
let mut reg = Registry::with_logging(Runtime::new()?, 1000, /*echo_stderr*/ false, Some(hook));

reg.logs();                    // everything buffered
reg.logs_for("greet");         // one slot only
reg.logs_since(last_seq);      // tail from a sequence number
```

## Cross-language, one host

| Plugin | Language | Build |
|---|---|---|
| `plugins/hello-rust` | Rust | `cargo build -p hello-rust --target wasm32-wasip1` |
| `plugins/hello-go` | Go | `cd plugins/hello-go && GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o hello_go.wasm .` |

```sh
host> load greet target/wasm32-wasip1/release/hello_rust.wasm
host> load goplug plugins/hello-go/hello_go.wasm
host> tools
  greet       (slot greet)   Return a greeting for `who`
  go_upper    (slot goplug)  Uppercase a string (Go stdlib)
```

## Measured (Apple M2 Pro, wasmtime 44, release)

| per load/unload cycle | Rust plugin | Go plugin |
|---|---|---|
| load (init + describe) | 54 µs | 358 µs |
| invoke a tool | 6.9 µs | 29.8 µs |
| **drop (real unload)** | **7.8 µs** | **18 µs** |
| full cycle | ~135 µs | ~530 µs |

| 100 instances resident | Rust | Go |
|---|---|---|
| RSS | ~12 MB (119 KB each) | ~261 MB (2.6 MB each) |
| load all / unload all | 5.2 ms / 0.87 ms | 37.7 ms / 4.9 ms |

RSS stays flat across 3000 cycles → no leak. Go costs ~20× more per instance
because each instance bundles the Go runtime.

### Disk compile cache (P2)

`Runtime::new_cached(dir)` caches precompiled `.cwasm` artifacts. A warm cache
turns a cold compile into a deserialize — Go plugin (10.6 MB module):

| | `load()` wall time |
|---|---|
| no cache | 279 ms |
| cold (compile + write `.cwasm`) | 258 ms |
| **warm (deserialize)** | **7.3 ms** |
| **speedup** | **~36×** |

```sh
cargo run --release -p wasm-plugin-host --example bench_cache
```

Keyed by wasm **content hash** + engine **fingerprint**, so a rebuilt `.wasm`
recompiles and a changed engine config invalidates the cache. Artifacts are
written atomically and a corrupt one is dropped and recompiled. Enable it in
the config: `"cache": { "dir": ".cwasm-cache", "enabled": true }`.

> **Trust boundary:** deserializing a `.cwasm` is `unsafe` (wasmtime assumes a
> compatible producer), so the cache directory must be writable **only by the
> host** — the usual build-cache assumption.

## Embedding

The logic is a library; the CLI is a thin shell over it:

```rust
use wasm_plugin_host::{Registry, Runtime, Supervisor};

let mut reg = Registry::new(Runtime::new()?);
reg.load("greet", "greet.wasm".as_ref())?;
let out = reg.call_tool("greet", &serde_json::json!({"who":"world"}))?;

reg.reload("greet", "greet-v2.wasm".as_ref())?;   // atomic hot-swap

let mut sup = Supervisor::new("plugins.json".as_ref())?;
sup.reconcile(&mut reg);                          // config → running state
```

## Concurrency

`Store<T>` **is `Send`** (verified), so a `Plugin` can be moved between threads.
It is **not `Sync`**: one instance is used by one thread at a time. Two building
blocks follow from that:

**Allocation strategy.** `Runtime::new()` uses on-demand allocation. For many
plugins or heavy churn (hot-reload), use a pooled allocator:

```rust
use wasm_plugin_host::{AllocationStrategy, Runtime};
let rt = Runtime::with_strategy(AllocationStrategy::pooled_default())?;
assert_eq!(rt.strategy_name(), "pooled");
```

The pool pre-reserves instance slots, so instance creation is O(slots) and
predictable. `linear_memory_keep_resident` bounds what is actually committed;
modules with no declared memory maximum are treated as up to 4 GiB, which is why
`max_memory_bytes` defaults to 4 GiB.

**Parallel calls.** `Registry::call_many_parallel` runs calls **one thread per
plugin**: calls to *different* slots run in parallel, calls to the *same* slot
are serialized (they share one instance). Results come back in input order; a
failing call returns an error in its own position without aborting the rest.

```rust
let out = reg.call_many_parallel(&[
    ("bash", serde_json::json!({"cmd": "ls"})),
    ("grep", serde_json::json!({"q": "TODO"})),
]);   // Vec<Result<Value>>, same order
```

## Composing with a dsh agent harness

The [`dsh-wasm-host`](dsh-wasm-host) crate mounts this runtime inside a real
[`dsh-rs`](https://crates.io/crates/dsh-rs) (cordis) harness: a `.wasm`
plugin's tools are registered on dsh's `ctx.tools` and driven by dsh's **own
agent loop**, and its hooks are bridged to dsh's flow waterfalls.

dsh already ships a dynamic-plugin host — but it is `dlopen`/cdylib based: a
mapped library is **never unmapped**, and a crash can take the host down. This
crate is the WASM analogue, keeping what `dlopen` cannot give you: a plugin's
code and linear memory are **really released** on unload, and a broken rebuild
is **rejected before** it can replace a running plugin.

```sh
cargo build --release -p hello-rust --target wasm32-wasip1
cargo run -p dsh-wasm-host --example compose
```

```
tools on ctx.tools: ["bash", "echo_num", "greet", ...]
wasm tool result: Hello, wasm! (now_ms=...)
[hello] info: greet called for `wasm`
```

See [`dsh-wasm-host/README.md`](dsh-wasm-host/README.md) for the bridge
mapping (which guest decision maps to which dsh point) and the known limits.

## Watching (notify, not polling)

`Supervisor::watcher()` uses the [`notify`](https://docs.rs/notify) crate to
watch the plugin files **and the config file**. `Watcher::wait(fallback)` blocks
until a change is seen (with an 80 ms debounce to coalesce a save's event burst),
or until the fallback elapses. The daemon loop (`--supervise`) is therefore
event-driven:

```
# with watch.interval_ms = 30000 (a 30s fallback), a wasm swap still applied in ~136 ms
supervising plugins.json (notify watcher); Ctrl-C to stop
reloaded `greet`: [...] -> [...]
```

The fallback still matters: a plugin file may appear that did not exist when the
watcher was built. If the platform watcher cannot be created, the host logs that
it is falling back to mtime polling.

## Caveats

1. **Go modules are reactors** — the host calls their `_initialize` once after
   instantiation (`runtime.rs::instantiate`). Rust cdylibs are unaffected.
2. **Go bundles its runtime** — ~2.6 MB per instance vs ~119 KB for Rust. For
   many plugins, prefer Rust.
3. **No capability/permission model yet** — plugins receive full WASI. This is
   not yet a sandbox for untrusted third-party code (the top roadmap item).
4. **A failed reload records the new mtime**, so a broken build is not retried
   every tick — fix and rebuild to trigger the next attempt.
5. **ABI v1** is version-gated; mismatched plugins are rejected at load.
6. **The streamed-chunk event is `assistant/chunk`** (aligned with dsh-rs); the
   older name `llm/chunk` is still accepted as an alias.
7. **The disk cache is not a trust boundary** — deserializing a `.cwasm` is
   `unsafe` in wasmtime, so the cache dir must be host-only-writable.

ABI details: [`docs/ABI.md`](docs/ABI.md).
