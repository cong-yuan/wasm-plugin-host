# dsh-wasm-host

> Run [`wasm-plugin-host`](../host) **WASM** plugins inside a
> [`dsh-rs`](https://crates.io/crates/dsh-rs) (cordis) agent harness.

`dsh-rs` already ships a dynamic-plugin host — but it is `dlopen`/cdylib based
(`dsh_rs::bundle::dynamic`). A cdylib is mapped into the process and **can never
be unmapped**; a crash in it can take the host down with it. This crate is the
**WASM** analogue, and it keeps the two properties `dlopen` cannot give you:

* a plugin's code and linear memory are **really released** on unload;
* a broken rebuild is **rejected before** it can replace a running plugin
  (stage-then-commit).

Everything else — the agent loop, `ctx.tools`, the event bus, the service graph
— is dsh's. This crate does not reimplement the harness; it plugs the WASM
runtime into it.

## How the two sides wire together

```
  dsh-rs agent loop            wasm-plugin-host
  ─────────────────            ────────────────
  ctx.tools  ◄── register_dynamic_tool ──  Registry::list_tools
     │ exec                                        ▲
     └── invoke ─────────────────────►  Registry::call_tool ── guest

  agent/pre-step   ─┐
  agent/request     ├─ waterfall ──►  Registry::dispatch ── guest hook
  tools/pre-execute ─┘                     │ Decision
                                           ▼ continue / rewrite / veto
  session/event (emit) ── observe ──►  Registry::dispatch (observe hooks)
```

* **Tools** — every tool a WASM plugin declares is registered on dsh's
  `ctx.tools` as a *dynamic tool*, so the agent loop calls it exactly like a
  built-in (`bash`, `read_file`, …). Execution hands off to the guest through
  `Registry::call_tool`.
* **Flow** — dsh's intervention waterfalls are bridged to the WASM hook bus. A
  guest returns `continue` / `rewrite` / `veto`, and the bridge translates that
  into the decision shape each dsh point expects.
* **Observe** — the `session/event` firehose is fanned out to guest `observe`
  hooks for `turn/start`, `assistant/chunk`, `tool/call`, …

## Quick start

```rust
use dsh_wasm_host::{install, LoadSpec, WasmHost};

let ctx = cordis::Context::new();
dsh_rs::bundle::install_base_default(&ctx).await?;

let host = WasmHost::new()?;
install(
    &ctx,
    host.clone(),
    vec![LoadSpec::new("greet", "plugins/greet.wasm")],
).await?;

// Now the agent loop can call the guest's tools, and the guest's hooks fire
// at dsh's flow points.
```

Run the end-to-end example:

```sh
cargo build --release -p hello-rust --target wasm32-wasip1
cargo run -p dsh-wasm-host --example compose
```

## Mapping table

| dsh point | guest `veto` | guest `rewrite` |
|---|---|---|
| `tools/pre-execute` | → `{kind:"deny"}` | ignored¹ |
| `agent/pre-step` | → `{kind:"reject"}` | → `{kind:"enter", messages}` |
| `agent/request` | ignored² | → the replacement `LlmCallConfig` |
| `session/event` | — | — (observe only) |

¹ dsh accepts only `allow`/`deny`/`ask` at `tools/pre-execute`; argument
rewriting belongs at `tools/execute`, which is **not** bridged.
² this point has no reject vocabulary; dsh will surface a parse error instead.

### One vocabulary rename

dsh emits `assistant/chunk`; our hook vocabulary calls that same point
`LlmChunk` (`llm/chunk`). The bridge performs that rename in one place
(`bridge::session_event_to_flow`).

## After a hot reload

Reloading a slot can change its tool surface. Call `resync_tools` to bring
`ctx.tools` back in sync:

```rust
let mut tracked = vec!["greet".to_string()];
host.reload("greet", "plugins/greet.wasm", None)?;
let (added, removed) = dsh_wasm_host::plugin::resync_tools(&tools, &host, &mut tracked);
```

## Testing

```sh
cargo test -p dsh-wasm-host
```

Tests are hermetic: plugins are tiny WAT modules compiled in-process, so no
`cargo build` of a wasm plugin and no network are needed.

## Known limitations

* **A guest's veto reason is not propagated.** The host's `Registry::dispatch`
  breaks out of the subscriber loop on a veto without copying the guest reply
  into the returned `Dispatch`, so the bridge reports a stable generic reason
  (`"denied by wasm plugin"`). Propagating the real reason needs an additive
  field on the host's `Dispatch`.
* **`tools/execute` and `tools/post-execute` are not bridged** — only
  `tools/pre-execute` is. Adding them is mechanical once argument rewriting is
  wanted.
* **No permission model yet.** Plugins currently receive full WASI; this crate
  inherits that (see [`docs/计划.md`](../docs/计划.md) P0). **Do not run
  untrusted plugins.**
