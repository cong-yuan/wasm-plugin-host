# Phase A — Studio Agent control plane: contract and remaining host work

Status (2026-10-09): **Bridge and Studio native execution integrated and tested in their respective repositories.** Memory includes private Agent notes and an opt-in cross-chat shared fact bank with explicit user-directed capture and deletion. `ask` supports a 90-second, one-call-only approval/denial UI, and denies unapproved calls by default. `dsh-wasm-studio` is a separate Git repository. This plugin commit cannot atomically commit changes to that repository, its vendor runtime, and this plugin.

## Native command contract (authenticated Studio binding only)

| Capability | Native commands | Preconditions for `ok: true` |
| --- | --- | --- |
| Thinking level | `get_session_runtime_controls`, `set_session_thinking_level` | Host must deliver selected effort to the actual model wire/driver for that session, not only store a string |
| Permission mode | `get_session_runtime_controls`, `set_session_permission_mode` | Host must enforce mode per session at tool pre-execution and any direct side-effect entry point; `read_only` must deny every write/exec pathway |
| Memory toggle | `get_session_runtime_controls`, `set_session_memory_enabled` | Host must apply the value to memory retrieval/prompt/context and persistence, including resumed sessions |
| Primary Agent switch | `get_primary_agent`, `switch_primary_agent` | Host must verify target exists, update the active primary routing/selection, persist the choice, and return the requested Agent ID |
| Per-Agent config | `get_agent_config`, `patch_agent_config` | Host must return and enforce a durable `revision`; patch must be an authenticated compare-and-swap and apply to the relevant Agent's actual runtime |

`get_agent_control_capabilities` returns `{ok:true,capabilities:{thinkingLevel,permissionMode,memoryToggle,primaryAgentSwitch,agentConfigWrite}}`. Each boolean may be `true` **only after** the corresponding runtime behavior is enforced, not merely because a Tauri command was registered. Missing, incomplete or failed responses report all capabilities as unavailable. Unsupported older Studio hosts return explicit errors and never receive local fake writes.

Native reads and mutations must confirm target identity: session controls return `{ok:true,agentId,level,mode,enabled}`, setters echo the requested field, primary switch returns `{ok:true,agentId}`, configuration read returns `{ok:true,agentId,revision,config}`, and configuration patch returns a **new** revision with the changed fields. The bridge rejects any response that omits `ok:true`, mismatches target/fields, or echoes a stale revision. Unknown agent/config keys and invalid enum values are rejected before dispatch. Mode is `read_only` on the OpenHanako wire (accepts legacy `read-only` input, canonicalizes it).

## Host implementation checklist and remaining product boundaries

1. Implemented: nine native methods in the Studio Tauri command registry and authenticated plugin bridge, with native capability acknowledgments. (Host restart/reload required after upgrading.)
2. Implemented: supported OpenAI reasoning models receive `reasoning_effort` in the vendored `dsh-rs` wire adapter. Unsupported models remain locked.
3. Implemented: session-scoped tool dispatch enforces `read_only`; `ask` pauses the exact tool call for explicit native approve/deny with argument inspection, timeout, cancellation, one-time consumption, and policy-change invalidation. Non-tool/direct Tauri operations remain outside this model-tool permission boundary.
4. Implemented: per-Agent saved memoryNotes and opt-in shared facts enter the model only while enabled. Explicit user-directed `Remember:` / `请记住：` instructions enter a durable, deduplicated shared fact index, and the UI supports opt-in, review, and deletion. General LLM-driven semantic memory extraction is not implemented or claimed.
5. Implemented: persisted primary Agent selection and revision-aware per-Agent configuration; live model changes use Studio rebind, not local overlays.
6. Tests added for durable config readback, live tool-body approval/denial, memory context gating and shared opt-in/deletion, revision conflicts, native command ACK, model wire reasoning, DOM interaction, React typecheck and production renderer bundle. Physical GUI click-through/restart orchestration remains a separate deployment verification step.

The iframe/legacy bridge and its tests are now ready to consume strict native acknowledgments. The standalone legacy UI still correctly disables unsupported controls. The real upstream React Settings `PUT /api/agents/:id/config` must be updated to provide a revision-aware patch before editing becomes available: legacy unversioned PUT cannot be silently treated as a successful save.

## Backend implementation update (2026-10-09)

The above previously-blocked native commands are implemented in local `dsh-wasm-studio` (a distinct repository). Native control settings are durably stored in `agent-controls.json` and applied at the vendored `dsh-rs` model/tool execution layers. An interactive one-call native approval UI and explicit, opted-in shared memory review/capture have been implemented in the subsequent batch. This does not represent general LLM-driven semantic Memory or multi-app knowledge indexing. The contract tests in the plugin and Rust runtime tests demonstrate fail-closed behavior and durable readback; no fake local overlays are used for native control mutations.
