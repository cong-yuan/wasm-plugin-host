# ABI v1 — WASM Plugin Contract

A plugin is a **core WASM module** built for `wasm32-wasip1` (or any target that
exports `memory`). The host provides WASI Preview 1, so plugins may use `std`
(Rust), `fmt`/`os` (Go), etc.

The contract is deliberately tiny — **JSON strings over linear memory** — so it
is implementable in Rust, Go, C, Zig today, and via the Component Model for
JS/Python later.

## Guest exports (plugin → host)

| Export | Signature | Meaning |
|---|---|---|
| `memory` | `memory` | Linear memory (required) |
| `plugin_abi_version` | `() -> i32` | Must return `1`; host rejects mismatch |
| `plugin_alloc` | `(size: i32) -> i32` | Allocate `size` bytes, return pointer (0 = fail) |
| `plugin_free` | `(ptr: i32, size: i32)` | Free a block previously handed out |
| `plugin_init` | `() -> i32` | One-time init. `0` = ok, non-zero = fail |
| `plugin_describe` | `(out: i32, cap: i32) -> i64` | Write declaration JSON into `out`; return bytes written, or `-(needed)` if `cap` too small |
| `plugin_invoke` | `(op: i32, op_len: i32, args: i32, args_len: i32, out: i32, cap: i32) -> i64` | Run op `op` (UTF-8 JSON `args` → UTF-8 JSON result in `out`); same return convention as `describe` |
| `plugin_shutdown` | `()` | Release state. Called once, before the instance is dropped |
| `plugin_configure` | `(out: i32, cap: i32) -> i32` | **Optional.** Called once at load, after `plugin_init`, when the entry has a `config`. Read it with `host.get_config`. `out`/`cap` are scratch space the host provides. `0` = ok |
| `plugin_on_config` | `() -> i32` | **Optional.** Called when the host pushes a new config to a **live** plugin. Re-read via `host.get_config`. `0` = ok |

## Guest imports (host → plugin)

Module **`host`**:

| Import | Signature | Meaning |
|---|---|---|
| `log` | `(level: i32, ptr: i32, len: i32)` | Log UTF-8 text (level: 0=debug 1=info 2=warn 3=error) |
| `now_ms` | `() -> i64` | Unix epoch milliseconds |
| `get_config` | `(out: i32, cap: i32) -> i64` | Write the current config as UTF-8 JSON into guest memory. Returns bytes written, `-(needed)` if `cap` too small, or `0` if the config is JSON `null` |
| `config_version` | `() -> i64` | Monotonic counter, bumped on every config change. Compare to a cached value to cheaply detect updates |
| `call_service` | `(svc, svc_len, op, op_len, args, args_len, out, cap) -> i64` | 调用另一个插件提供的服务(见下文) |
| `has_service` | `(name, name_len) -> i32` | 某服务当前是否可用 |
| `http_fetch` | `(req, req_len, out, cap) -> i64` | **联网的唯一方式**:宿主代发一个 HTTP 请求(见文末) |

## Logging

**The universal channel is WASI stdout/stderr — no per-language glue required.**
Any language's normal print goes there:

| Language | call |
|---|---|
| Rust | `println!` / `eprintln!` |
| Go | `fmt.Println` / `fmt.Fprintln(os.Stderr, ...)` |
| C | `printf` / `fprintf(stderr, ...)` |
| Zig | `std.debug.print` |
| JS (jco) | `console.log` / `console.error` |
| Python | `print()` / `sys.stderr.write` |

The host gives every instance a custom `StdoutStream`/`StderrStream` that
splits the byte stream into lines and feeds them into the shared `LogSink`.
stdout is logged at `Info`, stderr at `Error`. A trailing line without a newline
is flushed when the instance drops, so nothing is lost.

A plugin built in **any** language, using only its stdlib print, shows up as:

```
#1  [greet] info:  hello from Go stdout
#2  [greet] error: hello from Go stderr
```

### `host.log` — optional structured upgrade

Guests that want an explicit level (e.g. `Warn`/`Debug`, which have no separate
WASI fd) may call `host.log(level, ptr, len)` with UTF-8 text in their own linear
memory. Both channels feed the same sink.

The host turns every line into a `LogRecord`:

```rust
pub struct LogRecord {
    pub seq: u64,        // monotonic, for tailing
    pub slot: String,    // the slot it was loaded under, e.g. "greet"
    pub plugin: String,  // the plugin's own name, e.g. "hello-rust"
    pub level: LogLevel, // Debug | Info | Warn | Error
    pub message: String,
}
```

Each record is:

1. **stored in a bounded ring buffer** (default 1000 records; older ones are
   dropped — a chatty plugin cannot grow memory without bound),
2. **echoed to stderr** as `[slot] level: message` unless disabled, and
3. **passed to an optional `LogHook` callback**, so an embedding host (e.g. a
   Tauri backend) can forward records to its UI.

Reading logs back from the host:

```rust
let reg = Registry::with_logging(runtime, 1000, /*echo*/ true, Some(hook));
reg.logs();                    // all buffered records
reg.logs_for("greet");         // just one slot
reg.logs_since(last_seq);      // tail
reg.log_sink().clear();        // drop the buffer
```

## Declaration JSON (`plugin_describe`)

```json
{
  "name": "hello-rust",
  "abi": 1,
  "tools": [
    {
      "name": "greet",
      "description": "Return a greeting",
      "parameters": { "type": "object", "properties": { "who": { "type": "string" } } },
      "exec": "greet"
    }
  ],
  "hooks": [
    { "on": "tools/pre-execute", "exec": "check", "mode": "waterfall", "priority": 0 }
  ],
  "injects": ["sessions"],
  "provides": ["policy"]
}
```

`exec` is the `op` string the host passes to `plugin_invoke`.
`tools[].name` is how the agent-loop sees the tool.

## Frontend contribution (`ui`)

An **optional** `ui` block lets a plugin contribute to a frontend UI (our
desktop app, or any embedder that understands the same shape). The host treats
it as opaque data and hands it to the frontend, which resolves it.

> ⚠️ **Two different `provides`/`injects` pairs.** The **top-level** ones are
> *services* (backend capabilities, see [Services](#services-injects--provides)).
> The ones **inside `ui`** are *UI slots* (places in the frontend layout). They
> share the words — the relationship is the same (one side opens, the other
> claims) — but they are separate graphs, resolved by different code, and a
> plugin may have one without the other.

```json
{
  "name": "ui-llm-panel",
  "abi": 1,
  "tools": [],
  "ui": {
    "provides": [{ "name": "ui-llm-panel.config", "description": "extra LLM settings" }],
    "injects":  [{ "slot": "settings.tabs", "priority": 10, "component": "LlmPanel" }],
    "assets":   { "entry.js": "studio.register(\"LlmPanel\", (el) => { el.textContent = \"hi\" })" },
    "windows":  [{ "name": "advanced", "component": "LlmAdvanced",
                   "title": "Advanced", "width": 620, "height": 480, "open": "manual" }],
    "adjusts":  [{ "slot": "settings.tabs", "from": "ui-llm-panel",
                   "action": "priority", "to": -100 }]
  }
}
```

### `provides` — slots this plugin opens

A **slot** is a named place in the UI. Opening one lets other plugins render
into it. Names are conventionally namespaced by the owning plugin
(`ui-llm-panel.config`); two live plugins may **not** open the same name.

### `injects` — places this plugin renders into

| Field | Meaning |
|---|---|
| `slot` | The slot to render into. May not exist yet — the claim stays **pending** and mounts when the slot appears. |
| `priority` | Lower renders first. |
| `component` | A name the plugin's `entry.js` registers via `studio.register(name, factory)`. |

Resolution rules (identical to the service graph):

1. **Order-independent** — claiming before the slot exists is fine.
2. **Reactive** — if the slot's owner unloads, contributors hide but are
   *remembered*; when the slot returns they reappear without re-registering.
3. **Conflict is an error** — two live plugins cannot open one slot name.

### `assets` — what the frontend runs

An opaque map of strings. `style.css` is injected as a stylesheet; every other
`.js` asset is executable plugin code. `entry.js` is the designated entry point;
**any other `.js` asset is a module** the plugin can pull in on demand.

The frontend runs `entry.js` with a `studio` object that exposes `register`,
`components`, `require`, `provideSlot`, `inject`, `renderSlot`, `openWindow`,
`closeWindow`, `windowParams`, `windowLabel`, and `dispose`.

`studio.renderSlot(slot, el)` is the missing half of opening a slot: a plugin
that **provides** a slot must also render its children somewhere, or nothing it
hosts will ever appear.

#### Multi-file plugins (`studio.require`)

A plugin is not limited to one file. Put helpers and components in their own
assets and require them:

```json
"assets": {
  "lib/dom.js":   "return { h: (tag) => document.createElement(tag) };",
  "panels.js":    "const { h } = studio.require('lib/dom'); …",
  "entry.js":     "studio.require('panels'); studio.inject('settings.tabs', 'Panel', 10);"
}
```

```js
const { h } = studio.require("lib/dom");   // the ".js" is optional
```

Rules:

* **Lazy** — a module runs on first `require`, so an unused one costs nothing
  and a broken unused one cannot take the plugin down.
* **Cached** — each module body evaluates **once** per plugin load.
* **Nestable** — modules may require each other.
* **Cycles throw** (`circular require of module "x"`) instead of recursing.
* **Unknown names throw** and list the modules that do exist, so a typo is a
  clear error rather than a silent `undefined`.
* **Edits take effect** — changing a module invalidates its cached body *and*
  re-runs `entry.js`, because the registrations the entry makes close over
  whatever the module returned. (Without the re-run, editing a helper would
  appear to do nothing.)

See `plugins/ui-multifile` for a worked example: three lines of `entry.js` and
three modules, one of which requires another.

### `windows` — top-level OS windows

| Field | Meaning |
|---|---|
| `name` | Stable id, unique within the plugin. The real window label is derived (`plugin-<slot>-<name>`, sanitized), so two plugins cannot collide. |
| `component` | Which registered component to render — **for `content: "app"`** (the default). |
| `content` | `"app"` renders a registered component full-window; `"html"` makes the window a **fully self-contained page** the plugin supplies (no app shell). |
| `html` | The page source when `content` is `"html"`. |
| `title`, `width`, `height` | Window chrome. |
| `open` | `"manual"` (the plugin opens it) or `"auto"` (the host opens it when the plugin activates). |

Plugin UI code is identical in slots and windows: the same component factory,
only the mount point differs. A window's own Tauri label is its identity, so a
window asks the backend what to render rather than being told via a URL param.

Windows carry **params**: `studio.openWindow(name, params)` passes JSON that the
window reads via `studio.windowParams()`. If the window is already open it is
focused and receives the params via the `studio://window-params` event instead
of being duplicated.

### `adjusts` — reshaping UI that already exists ⭐

**This is the capability that distinguishes this host.** A plugin loaded *later*
can reshape contributions made by plugins already loaded, **without touching
their code**.

```json
{ "slot": "settings.*", "from": "noisy-*", "action": "hide" }
```

| Field | Meaning |
|---|---|
| `slot` | Glob matched against the contribution's slot. `"*"` matches all. Defaults to `"*"`. |
| `from` | Glob matched against the **contributing plugin's id**. Omitted = any. |
| `action` | `hide` \| `unhide` \| `replace` \| `priority` |
| `to` / `by` | For `priority`: an absolute priority, or a delta on the plugin's own. |
| `component` | For `replace`: the component **the adjusting plugin registered**, to render instead. |

Adjustments are applied at **resolution** time — when a slot's render list is
computed — never by mutating another plugin's DOM. Three properties follow:

* **Composable** — adjustments fold in the load order of the adjusting plugins;
  a plugin loaded last has the final say.
* **Reversible** — unloading the adjusting plugin drops its adjustments and the
  UI returns to exactly what the other plugins declared. `hide` is not `delete`:
  the claim survives, so another plugin can `unhide` it.
* **Order-independent** — an adjustment that arrives before its target simply
  applies when the target appears (the same rule as `injects`).

A worked example is the `ui-curator` demo plugin: it declares **no `provides`
and no `injects`**, only two adjustments.

> **Known limitation:** when two plugins adjust the same target, the later
> loader wins silently — there is no conflict error, unlike slot-name
> conflicts. The Settings page lists every adjustment in effect so the state is
> visible, but competing adjustments are not flagged. See
> [`已知问题.md`](已知问题.md) §3.6.

## Intervening in the flow (`hooks`)

A plugin that declares only `tools` is a **leaf**: the flow calls it. A plugin
that declares `hooks` is a **participant**: the flow calls it *at* flow points,
where it can observe or intervene. This is the dsh model.

| Event | Fires | Payload in | May change? |
|---|---|---|---|
| `turn/start` | a turn begins | `{turn, input}` | observe |
| `agent/pre-step` | before a step | `{turn, input}` | **rewrite / veto** |
| `agent/request` | before the model call | `{turn, messages}` | **rewrite / veto** |
| `assistant/chunk` | each streamed chunk | `{turn, index, text}` | **rewrite** |
| `assistant/message` | a full message | `{turn, text}` | observe |
| `tool/call` | a tool is about to run | `{turn, name, args}` | observe |
| `tools/pre-execute` | right before a tool body | `{turn, name, args}` | **rewrite / veto** |
| `tool/result` | after a tool returns | `{turn, name, result}` | **rewrite** |
| `turn/end` | a turn finishes | `{turn, ...}` | observe |

> **名称变更(P3.6)**:流式分片事件现叫 **`assistant/chunk`**(与 dsh 一致)。
> 旧名 `llm/chunk` **仍被接受**作为别名,老插件无需修改。

### Hook modes

* **`"observe"`** — the plugin is called and its reply is **ignored**. For
  logging, metrics, telemetry. Cannot change the flow.
* **`"waterfall"`** (default) — the plugin's reply is a **decision** that gates
  the flow. The value passed to each subscriber is the value *as rewritten so
  far*, so an earlier rewrite is visible to later subscribers.

### The decision reply

A hook (waterfall) replies with one of:

```json
{ "kind": "continue" }
{ "kind": "rewrite", "value": { } }
{ "kind": "veto", "reason": "why" }
```

`rewrite` replaces the payload the flow carries on; `veto` stops the step, and
the flow reports who vetoed. Anything unrecognised is treated as `continue`
(fail-open): a hook can never wedge the flow by returning junk. A hook that
**errors** is recorded and skipped, and the flow continues.

### Services (`injects` / `provides`)

A plugin may declare the services it **needs** (`injects`) and the ones it
**provides** (`provides`). This is dsh's service graph: a plugin is a
**participant with declared capabilities**, not just a leaf.

**Responsive convergence.** A plugin is *active* iff every service it injects is
provided by some active plugin (a plugin may satisfy its own inject by what it
provides). Activation registers its tools, hooks, and services; a newly
registered service can satisfy another plugin's injects, so convergence iterates
to a fixpoint — a whole chain can light up in one pass. Losing a provider
cascades deactivation the same way.

```
load consumer (injects kv)          -> quiescent: missing=["kv"], no tools registered
load provider (provides kv)         -> consumer activates automatically (cascade)
unload provider                     -> consumer deactivates; its tools unregister
```

* A load fails if two plugins provide the same service.
* `LoadedReport.missing_services` lists what a plugin still needs.
* `LoadedReport.active` says whether its effects are currently registered.
* `Registry::is_active(slot)` and the `pending` state in `plugins` reflect this.

### Calling one plugin from another (`host.call_service`)

An active plugin may invoke another plugin **by service name** (not slot), so it
depends on the capability rather than a specific implementation:

```c
// wasmimport host call_service
//   (svc_ptr, svc_len, op_ptr, op_len, args_ptr, args_len, out_ptr, out_cap) -> i64
// returns bytes written, or -(needed) if out_cap is too small.
```

```c
// wasmimport host has_service
//   (name_ptr, name_len) -> i32   // 1 if a provider is registered
```

A call with no provider, or one that hits a plugin already executing (a
recursive call), returns a JSON `{"kind":"error", ...}` reply rather than
trapping — so a plugin can handle a missing or busy dependency gracefully.

**Re-entrancy.** While a plugin runs, it is taken out of the store; the callee
of a service call is taken out too and put back afterwards. So nested service
calls work, the store lock is never held across a guest call, and a direct
recursion (A calls B calls A) fails with a clear "busy" error instead of
deadlocking.

## Config injection and live config

Each plugin entry may carry a `config` object. It is delivered two ways:

1. **At load (push):** the host stores it in the plugin's shared state and, if
the plugin exports `plugin_configure`, calls that hook once. The plugin then
reads the value through `host.get_config`.
2. **At runtime (pull or push):** whenever the config changes, the host either
pushes it live (`plugin_on_config` runs, `host.get_config` returns the new
value immediately) or restarts the plugin — controlled per entry by
`restart_on_config` (see below).

```json
{
  "plugins": {
    "greet": {
      "path": "greet.wasm",
      "enabled": true,
      "config": { "greeting": "Hello" },
      "restart_on_config": false
    }
  }
}
```

* `restart_on_config: false` (default) — **live update**. The running instance
  gets the new config; `plugin_on_config` fires if exported. Cheap, no reload.
* `restart_on_config: true` — **restart**. The plugin is atomically reloaded so
  it re-reads the config during `plugin_configure` as if freshly started. Use
  this when a config change must rebuild internal state that the plugin can't
  otherwise refresh.

**Only the plugin whose `config` changed is touched.** The supervisor diffs each
slot's config independently; other plugins are neither reloaded nor
reconfigured. Same for `.wasm` rebuilds.

### Reading the config from a plugin

Rust:

```rust
#[link(wasm_import_module = "host")]
unsafe extern "C" {
    fn get_config(out: *mut u8, cap: usize) -> i64;
    fn config_version() -> i64;
}

fn config() -> serde_json::Value {
    let mut buf = vec![0u8; 64 * 1024];
    // SAFETY: buf is valid for buf.len() bytes for the duration of the call.
    let n = unsafe { get_config(buf.as_mut_ptr(), buf.len()) };
    if n <= 0 { return serde_json::Value::Null; }
    serde_json::from_slice(&buf[..n as usize]).unwrap_or(serde_json::Value::Null)
}
```

Go:

```go
//go:wasmimport host get_config
func getConfig(out uint32, cap int32) int64

//go:wasmimport host config_version
func configVersion() int64
```

## Result JSON (`plugin_invoke`)

```json
{ "kind": "success", "content": "Hello, world!", "value": { "who": "world" } }
```
```json
{ "kind": "error", "message": "bad argument", "code": "BAD_ARG" }
```

## Lifecycle (dsh / cordis style)

```
Pending ──load──▶ Init ──describe──▶ Active ──invoke──▶ Active
                                       │
                              unload ──┴──▶ Shutdown ──drop──▶ Disposed
                            (any failure) ─▶ Failed
```

Unloading is a **drop**: unlike `dlopen`, a WASM instance releases its code and
linear memory for real. Registration of tools is an *effect* that unwinds on
unload — the host removes them from the registry automatically.

## Why this shape (and where JS/Python go)

* **Now (core module):** Rust and Go compile to `wasm32-wasip1` and can export
  these symbols directly. Go uses `//go:wasmexport`; Rust uses `#[no_mangle]`.
* **Later (Component Model):** JS (`jco`), Python (`componentize-py`), and also
  Rust emit *components*, not core modules. The host speaks WIT instead of raw
  JSON-over-memory. The **lifecycle and registry layers are identical** — only
  the `PluginRuntime` backend differs. See `host/src/plugin.rs::Runtime`.


## Host imports (补充)

除 `log` / `now_ms` / `get_config` / `config_version` / `call_service` / `has_service` 外:

### `host.http_fetch(req_ptr, req_len, out_ptr, out_cap) -> i64`

发起一个 HTTP 请求。WASI p1 的 `sock_*` 在 wasmtime 里未实现,所以**这是插件唯一的联网方式**。

请求 JSON:
```json
{ "url": "https://...", "method": "POST",
  "headers": { "authorization": "Bearer ..." }, "body": "..." }
```

返回 JSON:
```json
{ "status": 200, "headers": { "content-type": "..." }, "body": "..." }
```
或 `{ "error": "..." }`(请求根本无法发出时)。**非 2xx 不是错误** —— 插件自己看 status 决定。
body 上限 8 MiB。
