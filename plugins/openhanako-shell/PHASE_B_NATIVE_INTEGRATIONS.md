# Phase B — native Studio integration (2026-10-09)

Native source: `dsh-wasm-studio` and its vendored `dsh-rs`; bridge + UI source: `wasm-plugin-host/plugins/openhanako-shell`. These are independent Git repositories and require individual commits. After replacing the host binary/plugin bundle, **restart Studio** to register its new commands and start the scheduler.

## Capabilities delivered

| Area | Studio native commands | UI/bridge behavior |
|---|---|---|
| Project folders, projects and session assignment | `get_project_catalog`, `put_project_catalog` | The existing `/api/session-projects` CRUD/reorder interface runs over a revisioned native snapshot. Mutations are serialized in the renderer and only acknowledged after native CAS; failed writes never claim success. Native project mapping is consulted when creating new sessions. |
| Persistent automation scheduling | `get_automation_jobs`, `mutate_automation_job`, `run_automation_job` | `/api/desk/cron` uses Studio's real persisted scheduler when commands exist, rather than local drafts that cannot run. Enabled jobs can execute a prompt through the native Agent path. |
| Shell confinement | Vendored `dsh-rs` `bash` tool | Existing `read_only`/`ask` modes remain enforced by the tool registry. A shell in `operate`/`auto` still requires a valid authorized workspace root and an OS kernel sandbox, otherwise returns `SHELL_SANDBOX` instead of starting an unconfined process. |
| Session-managed attachments | `list_session_attachments`, `read_session_attachment`, `delete_session_attachment` | The right rail lists the active session's managed uploads, offers verified download, and requires a second click for removal. No arbitrary filesystem path is accepted. |

Automation schedule semantics: `at` accepts RFC3339 or an epoch-millisecond number; `every` is a millisecond period of 60,000 or more; `cron` accepts 5-field expressions with the browser's fixed UTC offset saved on create/update. Cron day-of-month and day-of-week follow OR matching when both fields are restricted. When Studio is closed no tasks fire, and the scheduler is not an OS launch agent. Per-job alternate model/provider and arbitrary plugin action runners remain a separate extension, not simulated by prompt execution.

## Deployment / unfinished verification

- Restart a compiled Studio binary with the updated host and plugin; manually test approval + sandboxed `bash`, the automation trigger when Studio remains open, native project grouping after restart, and upload/download/delete of actual session files. CI-style DOM and Cargo checks cannot prove the physical GUI or kernel sandbox behavior.
- The local TUNL Runner itself disallowed executing nested macOS `sandbox-exec` (abort-trap), so only fail-closed behavior is verified there. On a real host verify permitted commands work inside a selected workspace and absolute-path escape/network/file write outside it is denied. The tool will refuse to run if that sandbox cannot initialize.
- Project catalog remains local-browser-only on an older Studio binary and does **not** auto-import historic localStorage projects after upgrade. An explicit import/migration tool would be a further enhancement.
- The right rail manages uploads in the selected session's Studio-managed cache; pending uploads without an assigned session are not yet automatically reassociated.
- Run: Studio Cargo check/test, `dsh-rs` tests, `npm --prefix plugins/openhanako-shell test`, `npm run typecheck`, and `npm run build:renderer` in `plugins/openhanako-shell/ui` before a release.
