//! # dsh-wasm-host
//!
//! Compose the [`wasm_plugin_host`] WASM plugin runtime with a **dsh-rs**
//! (cordis) agent harness: WASM plugins become first-class participants in a
//! real agent loop.
//!
//! ## What this crate is
//!
//! `dsh-rs` already ships a dynamic-plugin host — but it is `dlopen`/cdylib
//! based (`dsh_rs::bundle::dynamic`): a plugin is a native shared library the
//! process maps in and can never truly unmap. This crate is the **WASM**
//! analogue, and it keeps the two properties `dlopen` cannot give you:
//!
//! * a plugin's code and linear memory are really released on unload;
//! * a broken rebuild is rejected *before* it can replace a running plugin
//!   (stage-then-commit).
//!
//! Everything else — the agent loop, `ctx.tools`, the event bus, the service
//! graph — is dsh's. We do not reimplement the harness; we plug the WASM
//! runtime into it.
//!
//! ## How the two sides wire together
//!
//! ```text
//!   dsh-rs agent loop            wasm-plugin-host
//!   ─────────────────            ────────────────
//!   ctx.tools  ◄── register_dynamic_tool ──  Registry::list_tools
//!      │ exec                                        ▲
//!      └── invoke ─────────────────────►  Registry::call_tool ── guest
//!
//!   agent/pre-step   ─┐
//!   agent/request     ├─ waterfall ──►  Registry::dispatch ── guest hook
//!   tools/pre-execute ─┘                     │ Decision
//!                                            ▼ continue / rewrite / veto
//!   session/event (emit) ── observe ──►  Registry::dispatch (observe hooks)
//! ```
//!
//! * **One slot = one cordis plugin**: each WASM slot is mounted as its own
//!   plugin, so it has its own [`cordis::FiberHandle`], its own `inject` gate,
//!   and its own `provide`d services ([`WasmService`]). A slot whose `injects`
//!   are unmet stays PENDING; a slot that `provides` a service publishes it on
//!   the context for any other plugin (native or WASM) to `require`.
//! * **Tools**: each tool a WASM plugin declares is registered on dsh's
//!   `ctx.tools` as a dynamic tool, so the agent loop can call it exactly like
//!   a built-in. Execution hands off to the WASM guest through
//!   [`Registry::call_tool`].
//! * **Flow**: dsh's intervention waterfalls (`agent/pre-step`,
//!   `agent/request`, `tools/pre-execute`) are bridged to the WASM hook bus.
//!   A guest hook returns `continue` / `rewrite` / `veto`; the bridge
//!   translates that into the decision shape dsh expects at each point.
//! * **Observe**: the `session/event` firehose is fanned out to guest
//!   `observe` hooks for `turn/start`, `assistant/chunk`, `tool/call`, etc.
//!
//! ## Quick start
//!
//! ```no_run
//! # async fn run() -> anyhow::Result<()> {
//! use dsh_wasm_host::{install, WasmHost, LoadSpec};
//!
//! let ctx = cordis::Context::new();
//! dsh_rs::bundle::install_base_default(&ctx).await.unwrap();
//!
//! let host = WasmHost::new()?;
//! let mounted = install(
//!     &ctx,
//!     host,
//!     vec![LoadSpec::new("greet", "plugins/greet.wasm")],
//! ).await?;
//!
//! // Each slot is mounted as its own cordis plugin with its own fiber:
//! let greet_fiber = mounted.slot_fiber("greet").unwrap();
//! # Ok(())
//! # }
//! ```

pub mod bridge;
pub mod host;
pub mod plugin;

pub use bridge::{install_flow_bridge, FlowBridgeReport};
pub use host::{HostOptions, WasmHost, WasmToolInfo};
pub use plugin::{
    install, resync_slot_tools, resync_tools, FlowBridgePlugin, LoadSpec, Mounted, WasmService,
    WasmSlotPlugin,
};

/// Re-export the pieces of the WASM runtime a caller most often needs, so a
/// host can depend on `dsh-wasm-host` alone.
pub use wasm_plugin_host as wasm;

/// Re-export the cordis kernel (`cordis-rust`) so callers can name contexts,
/// services and fibers without adding a second dependency edge.
pub use cordis;
