# Phase A — Studio Agent control plane: contract and remaining host work

Status (2026-10-09): **Bridge wired and tested; native execution NOT implemented in this repository.** Do not advertise Phase A as operational on the installed Studio host. `dsh-wasm-studio` is a separate Git repository. This plugin commit cannot atomically commit changes to that repository, its vendor runtime, and this plugin.

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

## Implementation boundary to close in `dsh-wasm-studio` and runtime

1. Implement these nine native methods in the Studio Tauri command and authorized plugin command dispatcher, then advertise them only for the installed host version.
2. Implement real reasoning-effort delivery in the `dsh-rs` LLM generation path; the currently installed AgentOptions only provides provider/model/max_tokens.
3. Install per-agent policy enforcement in tool dispatch and shell/computer side-effect boundaries, including independent sessions, `ask` approvals and `read_only` strict denial. Never unlock UI modes before that enforcement exists.
4. Implement per-session memory enablement at the prompt injection/retrieval layer, with durable readback and isolation across resume/fork.
5. Implement durable primary routing and compare-and-swap per-Agent configuration. The current plugin's local/global model overlays are **not** per-Agent runtime configuration.
6. Add Tauri/Rust integration tests for restart persistence, model wire parameters, tool-denial, concurrent revision conflicts, and resuming while settings change. Run the full JavaScript suite plus native cargo tests after host integration.

The iframe/legacy bridge and its tests are now ready to consume strict native acknowledgments. The standalone legacy UI still correctly disables unsupported controls. The real upstream React Settings `PUT /api/agents/:id/config` must be updated to provide a revision-aware patch before editing becomes available: legacy unversioned PUT cannot be silently treated as a successful save.
