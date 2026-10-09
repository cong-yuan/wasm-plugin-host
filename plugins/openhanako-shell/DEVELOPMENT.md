# openhanako-shell 开发路线

> 目标：把 OpenHanako 的核心聊天体验可靠地接到 Studio backend。原则是优先接真实能力；底层没有的能力必须 fail-closed，不能用“假成功”掩盖缺口。

## 当前状态

已经完成的主链路：

- 会话列表 / 新建 / 切换 / 恢复
- 流式 thinking / text / tool 事件
- 模型列表、默认模型与会话内模型切换
- archive / restore / rename / delete
- pin / pin-order / session projects（当前为本地持久化；catalog project 已支持 workspacePath 映射）
- 用户资料、appearance、sidebar UI、quick chat、notifications（当前为本地持久化）
- automation 草稿 CRUD；Studio 无 scheduler 时明确拒绝启用
- 权限模式在 Studio 无底层控制命令时 fail-closed 到 `ask`

## Phase 1 — Core Chat Completion

目标：把日常会话操作补齐，避免核心聊天动作掉回 Hana Server 或 soft stub。

当前推进顺序：retry/fork、cleanup、search、Session 键盘可达性、批量操作、attachment/file ingest 已完成；本批继续把图片从“文件路径附件”升级为 Studio-native multimodal ContentBlock，并打通 OpenAI-compatible `image_url` wire format。

1. **Session retry + fork** — P0 / 已实现
   - `/api/sessions/turns/retry` → `retry_session_turn`
   - `/api/sessions/fork` → `fork_session`
   - OpenHanako UI 通过稳定 `entryId` / `turnInputEntryId` 定位节点，adapter 投影到 Studio branch command，不用“重发最后一句”或“新建空会话”伪装。
   - Studio `fork_session` 按目标 turn 的稳定事件边界创建真实 child session；返回新的 `sessionId/sessionPath`。
   - Studio `retry_session_turn` 在 idle session 上定位目标 turn，保留目标前缀、重建同一 session id，再提交原始或编辑后的 user input；busy / 非法 entry / role 不匹配均 fail closed。
   - OpenHanako 侧 `tests/studio-bridge.test.mjs` 已覆盖 retry/fork command 投影，UI `message-turn-actions` 已在 retry 后重新 hydrate authoritative transcript。
   - 宿主已有 `src-tauri/tests/session_branch.rs` 专门覆盖 branch 语义；当前开发机 shell 缺少 `cargo`，因此本轮无法重新执行宿主 Rust test，环境恢复后应补跑 `cargo test --test session_branch`。

2. **Fresh compact / cleanup / todo complete** — P1 / 部分完成
   - `/api/sessions/cleanup`：已按本地归档元数据的 `archivedAt` + `maxAgeDays` 选择候选，并通过真实 `dispose_agent` 永久删除；返回实际 `deleted/failed`。
   - `/api/sessions/fresh-compact`：已接入 Studio 原生 `fresh_compact_session`；Studio 使用当前 session 的 LLM route 生成 durable summary，追加 dsh `session/compact` 事件并 flush；后续 `derive_messages()` 只把最新 summary + 新消息交给模型，旧 JSONL transcript 保留用于 UI/audit replay。
   - `/api/sessions/todos/complete`：已接入 Studio 原生 `complete_session_todos`；读取当前分支最新 `todo/write` 快照，追加全量 `completed` 快照并 flush，UI 仍只有真实成功才清本地 todo。

3. **Search / summary / authorized folders / continue-deleted-agent** — P1 / 已完成
   - `/api/sessions/search`：已纳入 Studio iframe bridge；adapter 复用稳定的 title/content 两阶段搜索、transcript cache、limit 上限和已删除/归档过滤；SessionList 已支持 ArrowUp/ArrowDown/Home/End 键盘导航，并用 `aria-current=page` 标出当前会话。
   - Session bulk actions：支持 Ctrl/Cmd-click 多选、Shift range、Ctrl/Cmd+A 全选、Escape 清除；React SessionList 现在始终提供可见 session 的 Select All 入口，选中后才显示归档动作；批量归档通过单独的 `archiveSessions()` 串行提交并只刷新一次 session list，避免逐项归档造成多次 hydrate/race。
   - `/api/sessions/summary`：已接入 Studio 原生 `get_session_summary`；读取最近一次 durable `session/compact` summary，并返回 `createdAt/updatedAt`，重启/重新 hydrate 后仍可读；没有 summary 时返回 `hasSummary=false`，不伪造内容。
   - `/api/sessions/authorized-folders`：已接入 Studio 原生 `get_session_folder_scope` / `patch_session_authorized_folders`；scope 作为 durable `session/authorized-folders` 快照持久化，Tauri resume 后可恢复；dsh file/read-write/edit/glob/grep 工具按 canonical roots 做路径约束并拒绝越界/符号链接递归。任意 shell `bash` 命令仍不宣称受此文件 scope 限制，因此没有伪装成完整 OS sandbox。
   - `/api/sessions/continue-deleted-agent`：已接入 Studio 原生 `continue_deleted_agent_session`；对“不再 live、但 transcript 仍在 Studio persistence 中”的 session 创建新 Agent、迁移 user/assistant/tool-result transcript，再调用原生 fresh compact；永久 `dispose_agent` 仍是 destructive delete，因此真正已删除 JSONL 的来源继续返回 `session_not_found`。
- Archived Session UI：React ArchivedSessionsModal 在零选择时也提供 Select All；全选后可批量 restore / permanent delete，仍保留一次确认和统一 refresh。
- Runtime incremental：`/api/runtime-state` 返回稳定 `signature`，带 `?since=<signature>` 且无变化时只返回 `unchanged=true`；legacy sidebar 的 3 秒 runtime refresh 已使用该增量握手，避免重复传输完整 session runtime payload。

## Phase 2 — Model & Input

- `/api/preferences/models`：GET 读取 Studio `get_llm_config` 的当前 provider/model 作为 utility fallback；utility_large / vision / vision_enabled / search provider 已有受校验的本地 overlay 持久化，刷新后可恢复；secret API key 仍不落 localStorage。
- provider model metadata：`/api/providers/:provider/models/:model` 的 PUT/PATCH/DELETE 已从 soft-ack 改为真实 local overlay 写入/删除，并在 provider config、discovered-models 两条读取链路回显。
- `/api/session-thinking-level`：已从固定 `off` 改为显式 `medium + locked + capability_unavailable`，避免 UI 误以为 Studio 支持切换；宿主补真实 session thinking 原语后再接。
- `/api/upload-blob`：Studio 已补真实 `upload_blob` 宿主命令；base64 bytes 由 Tauri host 落到 `session-files/<sessionId>`（无 session 时进入隔离的 `pending` namespace），20 MiB 上限、session id 校验、文件名净化；普通附件继续以可信 `fileId → dest` 路径上下文交给 agent。`openhanako-shell` 的 plugin capability registry 现在也显式声明 upload / image / compaction / todo / summary / folder-scope 全套 native commands，不再出现 API 已接、宿主 capability allowlist 漏掉导致实际调用被拒的漂移。
- Native image path：桌面提交的 `images[]` 不再只停留在 WebSocket payload；Studio 新增 `send_message_with_images`，把图片转成持久化的 `ContentBlock::Image { url: data:, detail }`，OpenAI-compatible adapter 映射为原生 `image_url` content block。session JSONL 自包含图片数据，避免依赖本机临时路径。
- `/api/capabilities`：UI 可读取真实 `uploadBlob` / `sessionTodoMutation` / `thinkingLevel` 等 capability；Studio host 更新后 uploadBlob 与 todo mutation 会开放，旧/缺少 Tauri bridge 的环境继续 fail closed。
- backend command capability drift：测试会从 `js/lib/api.js` 提取所有 `tauri.invoke()` command，并要求全部出现在 `src/lib.rs` 的 plugin `backend_commands` 声明；同时固定保护新增的 upload/image/todo/compact/deleted-continuation/summary/folder-scope 八个 native commands。
- native command version drift：`tauri.invoke()` 与 `invokeNative()` 都纳入 capability drift 检查；当 bridge 已连接但宿主缺少某个 command（混合版本/旧宿主）时，upload、image、todo、compact、deleted-agent continuation、summary、authorized-folders 会统一返回 `capability_unavailable`，WS turn 也携带稳定 `error.code`；缺失 command 会在当前 bridge 生命周期内被记入 capability cache，后续 `/api/capabilities` 会立即把对应功能降为不可用，避免把“宿主没升级”反复报成普通发送失败。
- Studio-native workbench second slice：在第一阶段的 list/search/read/write 之上，新增 `workbench_rename_file` / `workbench_move_file` / `workbench_safe_delete` / `workbench_upload_file` 四个 native command contract；`/api/workbench/actions` 已按 action 精确路由，`/api/workbench/upload` 也纳入 capability gate，并同步 `/api/mobile/workbench/*`。safeDelete 约定走 recoverable trash/checkpoint，不允许桥接层把它降级成永久删除；upload 保留 base64/mimeType，并要求 host 自己执行 workspace scope 与大小限制。
- InputControlBar：backend 明确不支持 blob ingest 时禁用附件按钮、隐藏录音入口；thinking-level control 在 Studio 不支持时直接锁定并提供可访问说明。
- `/api/models/auxiliary-vision`：现在从 provider model metadata 的 `image` / `input` 投影 capability；没有任何模型声明 image 能力时仍 `capability_unavailable`，声明后立即回显可用模型。
- `/api/models`：会回显已持久化的 model metadata（name/context/maxOutput/input/image/reasoning/thinkingLevels 等），避免 Settings 保存后聊天模型选择器仍显示裸 ID。

## Phase 3 — Studio-native Agent

- 多 Agent 列表：GET `/api/agents` 现在读取 Studio `list_agents`；mock 模式也使用单独的 `studio` agent fixture，不再把 session rows 冒充 agents。`isPrimary` 只对明确的 `studio` Agent 投影为 true，不再按返回顺序猜 primary。
- agent switch：Studio 当前没有 primary-agent switch 命令，已改为带 `capability_unavailable` 的 fail-closed 响应，不伪造切换成功。
- agent config：GET 已投影 Studio 当前 provider/model，并明确标注 modelSwitch 与暂不支持的 thinking/permission/primary-agent 控制；真实 per-agent config 持久化仍待宿主能力。
- permission mode / read-only / operate / auto：继续保持 `ask` locked，待宿主控制面。
- 对 Studio backend 缺失的控制面先补宿主命令，再接 UI。

## Phase 4 — Workspace

- session-project assignment：已补 GET read-back，并在 POST 时校验 project 必须真实存在；React SessionList 支持多选后批量移动到 catalog project 或 uncategorized，并串行写入避免 localStorage read-modify-write race；assignment API HTTP/JSON 失败时 UI store 不再提前更新。
- session batch archive：已支持多选后一次性归档，并在成功后统一清理 session runtime/chat/file/todo cache；当前会话未被选中时保持焦点不跳走。
- archived batch actions：归档管理器现在支持 checkbox 多选后批量 restore / permanent delete；restore 只做一次 session reload，不逐条切换当前会话；delete 也串行写入后统一刷新列表。
- authorized folders：已落到 Studio session event + file-tool enforcement；shell sandbox 仍单独待宿主级能力。
- project / workspace mapping / 已完成第一阶段
  - catalog project 增加可选 `workspacePath`；创建项目时从当前 session 的 cwd 自动建立映射，旧 catalog 自动补 `null`。
  - 从 project 创建新 session 时优先使用 project workspace；显式 `cwd` 始终覆盖 project mapping；unknown project fail-closed，不创建幽灵 assignment。
  - Project 右键菜单现在可以选择/清除 workspace；cwd 自动生成的临时 project 不允许伪装成可编辑 catalog workspace。
  - 该映射仍属于 OpenHanako catalog 本地持久层，不冒充 Studio 的原生 project manager。
- embedded Studio file/workbench bridge：Workbench native 已覆盖 list/search/read/write、rename/move/recoverable safeDelete/upload；file-history 四条核心读写、ResourceIO 九条 request/response 核心操作、generated-resource preview 的 metadata/content，以及 checkpoints list/create/restore/remove 均已接回 capability-gated native bridge。每条 route 都由 parent hello 的精确 `backendCommands` capability gate；ResourceIO watch/subscription/events 与资源 ticket 继续留在 Hana，避免把长生命周期事件所有权或 ticket 密钥带入 iframe host command。
- file / workbench / resource / checkpoint 当前阶段：parent hello 通过 `backendCommands` 做逐 command 能力协商；没有 capability 时保持 Hana fallback，有 capability 才拦截对应 route。Workbench read 与 generated-resource content 都保留 MIME/长度/ETag/HEAD 元数据；generated-resource binary content 通过 base64 bridge 转成浏览器 `Response`。file-history restore、ResourceIO expected-version write、checkpoint restore/remove 都保留真实 error/conflict 语义，不 fake success；checkpoint id 在 route 与 store 两层都拒绝路径穿越，restore 也拒绝通过 symbolic link 写回。live bridge 与可复制 patch source 继续 byte-for-byte 同步，并由 `studio-backend-patch-sync.test.mjs` 回归保护。
- Sidebar UI persistence / 已完成第一阶段
  - Jian 右侧栏开关已从 `hana-jian` / `hana-jian-chat` localStorage 迁到 `/api/preferences/sidebar-ui.shell.jianOpen`。
  - sidebar / Jian / channel inspector / preview 四组宽度迁到 `/api/preferences/sidebar-ui.layout.*`；首次 server payload 缺少 `layout` 时从旧 `hana-*-width` keys 一次性迁移，之后以 Studio/adapter 持久值为准。
  - 宽度只接受 120–1200 的有限整数，非法值 fail-closed；localStorage 只保留首帧兼容缓存，不再作为长期 source of truth。

## Phase 5 — Extended Hana

按实际需求逐项决定哪些继续由 Hana Server 提供、哪些映射到 Studio：

- automation scheduler — Hana-owned `StudioCronService` + Studio-wide scheduler now support CRUD, suggestion receipt, `agent_session` execution, stable-session scope, permission/revision guards, and UI `Run now`. Manual execution reuses the scheduler timeout/lock/schema guard, records `manual: true`, and does not advance `nextRunAt` or disable one-shot jobs.
- MCP / connectors — connector configuration export is now available from the first-class and legacy routes. Exports intentionally contain only non-sensitive reusable config; tokens, secrets, env/header values, runtime status, and discovered tools are excluded. Settings exposes one-click JSON copy and credentials must be re-entered on import.
- plugins / widgets / pages — Plugin pages/widgets are now protected against stale concurrent catalog refreshes, and persisted hide/show/reorder preference writes are serialized so rapid UI changes cannot reorder the durable preference stream. Existing iframe/page/widget routing remains capability-gated.
- channels / DM — DM inspector now exposes a non-destructive reset action backed by `/api/dm/:peerId/reset`; it clears only the current Agent's phone projection/cache and activity UI while preserving the shared DM truth file. The action is owner-scoped, confirmed, and fail-closed on backend errors.
- memories — Agent Memory settings now expose JSON backup/restore for the selected Agent. Export downloads the existing server-generated memory payload; import accepts the versioned `facts`/`memories` array, routes it through the existing agent-scoped import endpoint, and broadcasts `hana-memories-changed` so an open Memory Viewer refreshes immediately after import or clear.
- browser — Session sidebar Browser Open/Close now use acknowledged server actions instead of optimistic UI success: open only invokes the platform viewer after `/api/browser/open-session` confirms success; close preserves visible browser state during the request, commits the authoritative session-state snapshot on success, clears media metadata, and leaves the badge available with an error toast for retry if close fails. Repeat open/close clicks for the same session are suppressed while pending. BrowserCard has keyboard-accessible viewer activation while collapse remains a local UI-only action; opening the viewer fails closed without a session path. Browser background stop events clear stale URL/screenshot metadata and a fresh stopped→running transition re-expands the card; periodic running updates keep the user's collapsed choice. Foreground `browser_status` navigation to a different URL (or stopped→running reuse) invalidates cached screenshots until the new page supplies its own thumbnail, while unchanged running-page updates may retain an explicitly stale image. Incomplete status frames without a boolean `running` are ignored rather than stopping an active browser; running deltas without a URL preserve the current URL, and thumbnails tied to another URL are rejected. On WebSocket reconnection, the desktop now consults the existing `/api/browser/session-states` backend snapshot to reconcile browsers that stopped, started, or navigated while offline. It validates the full response, rejects HTTP failures, preserves live WS updates made during the fetch, and ignores the result if the socket was superseded. Reconciled screenshots are cleared for changed pages, and user collapse state is retained for continuing sessions. Overlapping HTTP reconciliations use a request generation to discard stale responses even when a newer snapshot leaves runtime state unchanged; a collapse-only UI change while awaiting a snapshot retains user intent without suppressing runtime reconciliation.
- skills — Skills settings now has an explicit `Reload skills` action. It calls the backend reload endpoint, then refreshes the selected Agent skills and compatible external-path view; the action is guarded against concurrent clicks and covered by the existing SkillsTab safety net.
- media / image / video — Global image/video/speech configuration writes are serialized per capability, so rapid selector/toggle changes preserve user order; image/video provider refreshes also reject stale focus-triggered responses. Failed image generation cards now retry the existing task only when the backend returns an acknowledged, matching pending placeholder (validated by both the media route and renderer); malformed HTTP success can no longer fabricate an in-progress task. Pending image/video cards expose an explicit Refresh task status control that reads the authoritative media-task record: pending remains pending, failed/aborted shows the backend reason, and done resolves into a file block only when a real sessionFile was registered. Missing artifacts and wrong-session task responses remain errors rather than phantom outputs; existing WebSocket completion continues to work.
- resource-io / checkpoints / file history — File History restore requires explicit confirmation and backend acknowledgement; write conflicts/failures never produce false restore snapshots. When the native preview supplies a version token, restore passes it through the HTTP route into ResourceIO `writeExpectedVersion` and rejects concurrent changes with HTTP 409; legacy clients lacking a token still use the prior unconditional restore path. The modal runs restores single-flight, freezes file/version selection while writing, and drops late completion updates after an Agent/selection change. Restore HTTP 409 now becomes a distinct UI conflict state: the modal re-reads the current native file and its new version for comparison, never auto-retries, and disables retry when it cannot acquire a fresh version token. The HTTP client distinguishes confirmed version conflicts from ordinary failures. UI hydration ignores stale file/version/snapshot responses and checks snapshot ownership. Restore and checkpoint recovery refresh matching open preview documents via the version-aware refresh pipeline. Post-restore history hydration failures do not falsely report successful writes as failed. ResourceIO event catch-up rejects malformed/unsafe cursors and fail-closes HTTP/error payloads. Concurrent foreground/WebSocket catch-up requests coalesce into one in-flight operation; entire batches are validated for monotonic safe sequence numbers before any event dispatch, older events are not replayed over newer live projections, failed delivery leaves the affected cursor unacknowledged, and a failed fetch can be retried. Foreground recovery catches synchronous and asynchronous failures and resets its throttle on failure, so a later focus can retry immediately. Stale cursors reattach active watches before adopting a reset server sequence, and failed or unacknowledged watch responses cannot masquerade as a successful subscription. Watch subscriptions now track request generations: a late acknowledgement from an obsolete subscription is explicitly released rather than overwriting the current lease, and disposal while a subscribe is in flight cleans the eventual lease without leaking it. DELETE failures are surfaced in warnings; recovery does not treat missing subscription acknowledgements as success. Every catch-up also re-establishes already-failed active watches before event replay, without re-subscribing healthy leases or blocking on a still-pending original subscribe. Failed recovery stops that catch-up from falsely advancing the event cursor. Watch release callbacks are idempotent and bound to their original lease object, so stale component cleanup cannot release a later watch using the same path. WebSocket resource cursors are now acknowledged only after the synchronous message handler succeeds; a failed handler leaves its event eligible for reconnect catch-up. ResourceIO now rejects unacknowledged provider write results instead of auditing/emitting false success events, and local reads expose SHA-256 content tokens; expected-version writes honor SHA-256 comparison (including same-size content changes) and reject empty/stale-less tokens. For cooperating local_fs CAS writers a same-directory exclusive lock plus staged fsync-and-rename replacement ensures only one may commit at a time and prevents partial-file visibility, preserves file mode, and cleans transient artifacts on failure. New CAS locks record a private nonce, host, PID and creation time; explicit `LocalFsProvider.inspectExpectedVersionLock()` and `recoverOrphanedExpectedVersionLock(ref, nonce)` support operator-controlled cleanup only for an exact lock that is at least 60 seconds old, locally owned, and whose process is demonstrably dead. Unknown/ownerless, young, remote, live, and mismatched-token locks fail closed; the provider never auto-reclaims or silently steals a lock. Orphaned locks made by older builds lack owner metadata and must still be recovered manually. Explicit orphan recovery also refuses directories containing unexpected entries, preserving unknown content instead of partially deleting lock ownership metadata. Unrelated external writers that ignore this lock can still race, so this is not universal filesystem CAS. Checkpoint create/restore routes require acknowledgements; capture rejects nonregular/invalid UTF-8 content. New checkpoint records pin the canonical parent directory to detect post-backup symlink redirection (legacy records retain prior behavior). Restore stages full content in a same-directory exclusive temporary file, syncs it, preserves existing mode, and atomically renames into place; failed replacement leaves the prior target unchanged and removes temp files. Settings checkpoint restore is confirmed, single-flight, and refuses mismatched returned paths; regression tests cover these boundaries.

## 接线原则

1. 核心会话语义必须真实：retry/fork/archive/delete 等不能 fake success。
2. UI 状态与 Studio 状态只有一个 source of truth；本地兼容存储必须在文档中明确标注。
3. 新增 bridge endpoint 时必须有：正常路径、非法输入、底层 capability 缺失、刷新/历史 hydration 回归测试。
4. 跨仓能力优先在 Studio 暴露最小稳定 Tauri command，再由 `js/lib/api.js` 和 `hana-adapter.js` 投影成 OpenHanako API。

### Session search consistency (2026-10-09)

- Remote title/content searches for an identical normalized query share a single in-flight request, while each caller receives independent result rows.
- `clear()` invalidates both cached and pending search generations: old responses may complete for existing callers but cannot repopulate a cleared cache.
- The bounded query cache now uses access-order LRU eviction and defensive row copies; malformed or failed HTTP search phases reject rather than caching phantom empty results.
- `session-sidebar-utils.test.mjs` covers concurrent coalescing, clear-vs-response races, retry after failure, LRU eviction and caller mutation isolation.

### Sidebar async and bulk mutation safety (2026-10-09)

- Search typing invalidates older draw/search generations **before** the 180ms debounce. Both late successes and late failures now check the current generation and destroy state before updating search status or rows. Sidebar teardown invalidates outstanding work.
- Session mutations require explicit `ok: true`; single-target mutations and bulk archive/delete additionally check the target session ID if the backend supplies one. Bulk restore is the intentional exception: resumed sessions may legitimately receive a new ID. Partial or malformed responses remain failed rather than fake success.
- Bulk mutation operations are mutually exclusive. The original active/archived mode is pinned for the entire batch; post-request failure selection reconciliation only runs if the user has not changed selection or view.
- Changing a checkbox, selecting/clearing rows, or pruning missing selections revokes a pending destructive delete confirmation. A new confirmation is required for the new exact selection.
- Successful session archive, restore, delete, rename, and pin mutations invalidate cached searches and older in-flight sidebar drawings. Regression coverage is in `session-sidebar-utils.test.mjs` and the DOM smoke suite (failed search while typing, confirmation revocation, in-flight selection retention).

### Sidebar keyboard and range selection (2026-10-09)

- Legacy `openhanako-shell` sidebar now supports Ctrl/Cmd+click toggle, Shift+click inclusive range, Ctrl/Cmd+Shift additive range, and Shift-click on row checkboxes. Range anchors are always constrained to the currently visible result set and are reset when views/selections invalidate them.
- Focused session rows support Home/End/ArrowUp/ArrowDown navigation; Shift+navigation extends range selection; Ctrl/Cmd+A selects all visible rows; Space toggles the focused checkbox; Escape clears selection and cancels destructive confirmation. Enter opens an active session, or toggles checkbox selection for archived rows. Shortcuts never intercept nested input/button controls.
- A single roving Tab stop follows keyboard focus, with native DOM focus restoration after redraw; current session uses `aria-current=page`, and rows advertise keyboard shortcuts. Session IDs are matched as data instead of interpolated into CSS selectors.
- Visible bulk selection retains the existing toolbar controls. Every keyboard, checkbox, or mouse selection change invalidates the pending permanent-delete confirmation; no background batch can rewrite a newer user selection.
- Unit and real DOM smoke regressions cover range endpoints, additive selection, stale anchors, Ctrl/Cmd+A, Escape, keyboard focus, Tab stops, active/archived Enter, nested button/input isolation, and checkbox redraw.

### Archived session retention cleanup (2026-10-09)

- The standalone sidebar now exposes retention-based permanent cleanup only in Archived view. The retention input accepts whole days (1–3650) and previews the **backend-selected** candidate IDs/count before an explicit second confirmation; Cancel, retention edits, view switches, expired previews (60 seconds), and unmount revoke confirmation.
- Cleanup preview is a side-effect-free `POST /api/sessions/cleanup` with `dryRun: true`. Confirmed cleanup includes the full `expectedSessionIds` snapshot. The Hana adapter rejects malformed/duplicate IDs or mismatched candidate sets **before** invoking any disposal; legacy callers without `expectedSessionIds` still work.
- Cleanup, bulk restore/archive/delete share a single mutation lock. Real deletion acknowledges the exact session ID and surfaces partial failures. Successful cleanup refreshes archived rows and invalidates cached search results; missing/malformed backend acknowledgment never pretends that deletion succeeded.
- `studio-bridge.test.mjs` checks dry-run non-deletion, malformed snapshots, changed candidate rejection, retention validation and real disposal. DOM smoke covers view gating, preview/cancel, age-change re-preview, backend conflict, confirmation and list rehydration.

### Model selector async consistency (2026-10-09)

- The standalone conversation's model selector now versions each GET request against both the currently opened session epoch and request generation. A late initial fetch, abandoned popup fetch, or previous-session failure cannot overwrite new session models, labels, options, or error state.
- Popup open/close requests are intent-driven, so a double-click during loading cancels the first opening rather than leaving a reopened stale dropdown. Current expanded state is reflected in `aria-expanded`, loading is announced, and cancellation clears only its own transient loading label.
- Model selection requires `ok: true` with matching `model.id` and `model.provider` from the authoritative backend. Malformed success or a mismatched target fails visibly without changing the current model label. Model listing rejects malformed, unacknowledged, or explicit error payloads instead of showing phantom empty lists.
- DOM smoke regression cases cover session switching during initial discovery, popup cancellation, stale GET responses, mismatched switch acknowledgments, malformed listing responses, and the existing success/failure/lock behavior.

### Standalone session authorized folder editor (2026-10-09)

- The standalone conversation now exposes authorized session directory management through the Studio-native `get_session_folder_scope` and `patch_session_authorized_folders` bridge. A toolbar button stays visible even after the welcome screen disappears; the welcome folder button also opens the editor. Neither control is interactive when the backend lacks the exact capability.
- Opening the editor reads the currently active session's authoritative `authorizedFolders` list. Add / remove are acknowledged server mutations; no optimistic success, no localStorage shadow source of truth. User-entered paths must be absolute before request; the host is still authoritative for canonicalization, existence, and scope permissions. Empty, invalid, missing-session, and error payloads fail closed.
- Requests are single-flight while mutating and tied to the exact session epoch and request generation. Switching chats, closing the editor, or resetting the conversation invalidates pending reads and writes without leaking stale folders into the next session. The status area announces loading, backend errors, and acknowledged completion. DOM smoke covers capability gating, no-session guard, real read, relative path rejection, failed/successful add, remove and switch-during-read.

### Live assistant text/tool chronology (2026-10-09)

- The standalone conversation now maintains transient, event-order `streamTimeline` segments for each active assistant turn. Consecutive text deltas coalesce within the same segment; tool start inserts its own segment so later text is rendered **after** that tool instead of being flattened in front of all tool cards. Duplicate tool starts do not duplicate tool cards; a completion-only tool event creates a visible synthetic start and accurate result state.
- After a successful authoritative transcript read, exact single-assistant latest turns retain the live timeline only when model text remains a prefix match and every streamed tool ID is present in the authoritative reply. A trailing authoritative text suffix is preserved. Multi-row persisted assistant transcripts continue to use native row order without inventing cross-row chronology.
- Failed sends after partial tool/text activity keep their error visible in the live timeline. Interleaving is not falsely claimed as durable across a reload unless a future host transcript format persists event-order segments. DOM smoke covers text → tool → text → tool, completion-only failed tools, and hydration with preceding history.

### Studio-native standalone chat attachments (2026-10-09)

- The previously disabled standalone attach button is now capability-gated by the actual native `upload_blob` command. Users can choose up to five nonempty files, each at most 10 MiB, see/remove staged chips, and send file-only prompts. Files are read locally and uploaded only **after** the owning session exists; raw blobs go through the existing authenticated `/api/upload-blob` bridge, not an external cloud service.
- Every upload requires `ok: true`, a real string `fileId`, and nonempty string destination. The generated message includes the host-owned session-file paths only after all uploads are acknowledged. When the native `send_message_with_images` command is available, images also ride its durable multimodal ContentBlock path; otherwise they remain referenced only as local files and are not represented as an embedded image.
- Failure preserves staged files and presents the real backend error, without dispatching a chat turn. Successfully uploaded files are reused on a same-session retry to avoid duplicate uploads after partial failure. Switching/resetting sessions clears staged files, upload completions arriving after a session epoch change are ignored, and Stop during an in-flight upload prevents the later chat message from being dispatched. DOM smoke tests cover capability gating, staging/removal, size limits, real upload/multimodal send, missing acknowledgments, retry reuse, session creation before upload, and reset/cancel while upload is pending.

### Studio session context actions in standalone chat (2026-10-09)

- The always-visible standalone `Session` toolbar button now opens a native capability-gated context actions panel for `get_session_summary`, `fresh_compact_session`, and `complete_session_todos`. Controls remain disabled if their exact command is absent, or while the session is opening/busy. No session ID means no mutation or summary read.
- Read summary requests display the backend's durable summary or explicitly state no summary exists; invalid/error responses cannot masquerade as an empty summary. Compact and complete-all-TODOs each require an explicit confirmation click and real backend acknowledgment before reporting success. Compaction retains transcript history; TODO completion must return an acknowledged full completed snapshot, and the adapter no longer converts `undefined` native responses into successful empty TODO arrays.
- Requests are tied to the selected session epoch and request generation, so a late summary cannot leak into another session. Per-session native operations remain locked even if the user closes and reopens the panel during an in-flight mutation. Success/error statuses are announced in a live region, with no optimistic projection updates.
- DOM smoke regression covers capability, no-session guard, summary hydration, confirmation, rejected compaction, malformed TODO acknowledgment, successful completion, in-flight close/reopen single-flight, and stale read after switching sessions. Studio bridge test covers a missing native TODO acknowledgment.

### Native standalone slash commands (2026-10-09)

- Replaced the disabled slash command button with a local, keyboard-dismissable command menu. `/help`, `/models`, `/folders`, `/summary`, `/compact`, and `/todos` are shortcuts only to existing Studio-capability-gated controls. They never invent server command dispatch or fabricate a backend acknowledgment.
- Exact slash input is intercepted before send/create/upload. Unsupported or unknown commands and extra arguments remain editable with an explicit error instead of silently entering the chat transcript; attached files cannot piggyback on commands. `/compact` and `/todos` arm the existing required confirmation and do not immediately execute irreversible session actions.
- Command availability follows the current session and host capabilities; menu options are disabled when no session or backend capability exists. Popup Escape, session switch and reset close the menu and clear the transient state. DOM smoke covers help/menu, capability gating, summary and native compact confirmation, authorized folders, unknown/argument errors, and chat-send isolation.

### Read-only native session file history in standalone rail (2026-10-09)

- The formerly placeholder-only `Session files` rail tab now identifies itself as a **read-only tracked file history** browser. It queries the native `file_history_list_files`, `file_history_list_versions` and `file_history_get_snapshot` routes for the currently selected session, with refresh, file/versions drilldown, and truncated text snapshot preview. This is intentionally not a claim to browse arbitrary attachments or workspace files.
- `shell.js` passes selected session IDs into the rail on open, create and reset. Async file-history reads are versioned by tab and session; responses from previous sessions/tabs/unmounted panels are ignored, and a mismatched snapshot path is rejected rather than displayed.
- Missing native capabilities, HTTP failures and malformed backend data are shown explicitly. The view never invokes file mutations, restore, delete or a fake fallback. DOM smoke exercises the file→version→snapshot flow, stale-session isolation, wrong-file snapshot rejection and capability/error states.

### Native read-only workspace browser in standalone rail (2026-10-09)

- The Workspace tab now includes a read-only native file browser for the Studio-owned `default` workbench root, alongside existing runtime/tool diagnostics. It supports scoped directory listing, relative subdirectory navigation, Up/Refresh, and text-content previews (truncated to 16,000 characters); it does not offer synthetic writes, unsafe restores, or expose direct absolute host paths.
- Directory names are verified as single safe path components, list responses must match the requested root/subdir, and content responses must explicitly acknowledge HTTP 200 and a text-compatible MIME type before being rendered as literal text. Unsupported native commands are shown as unavailable, not faked.
- Workspace navigation and tab switches version pending requests. Late results from an abandoned directory or inactive tab cannot overwrite the current UI. DOM smoke covers navigation, read-only preview, binary refusal, unsafe names, mismatched roots, capability gating and stale concurrent loads.

### Native workspace search in standalone rail (2026-10-09)

- The read-only Workspace browser now exposes native file search (`workbench_search_files`) with a scoped default workbench root, a 160-character input limit, Enter/Click submission and result counts. File results open through the existing native text-preview flow at their validated relative parent directory; directory results navigate into that folder.
- The bridge response must acknowledge a valid results array and match the requested root/query when supplied. Only safe, single-component path segments are accepted for every relativePath; traversal, invalid paths and mismatched entry names fail closed rather than being promoted to read operations.
- Typing invalidates pending searches immediately, and tab/navigation/version guards reject stale responses. The browser never invokes workspace mutations or invents file contents. DOM smoke exercises successful native search→preview, unsafe result rejection and tab-switch races.

### Native versioned workspace text editing and create (2026-10-09)

- Workspace text previews with an authoritative host file version now expose a capability-gated `Edit text` action; directory listings offer `New file` when `workbench_write_file` exists. Edits are limited to 256,000 characters and valid single-component filenames. Missing file version, binary content, or absent host capability stays read-only.
- Existing files save via the native `/api/workbench/actions` `writeText` with `expectedVersion` sourced from the native read response (`X-Hana-File-Version`); new files use `create` (`mustNotExist` in host bridge). Missing/malformed native mutation acknowledgments never count as success, and native actions require explicit `ok: true` rather than treating undefined results as success.
- Unsaved edits block tab switches, refresh, directory navigation and search until Save/Discard; save runs single-flight and disables discard during native mutation. Conflict/failure retains the draft and version for correction/retry. Unrelated runtime updates do not redraw an active textarea. Success requires an acknowledged new version and refreshes the in-panel preview.
- Tests cover read-version envelope, native missing-ACK fail-closed behavior, successful versioned save/new-file create, collision/conflict recovery, unsafe filename refusal, unsaved navigation guard and duplicate-save lock.

### Native workspace rename, move and safe-delete actions (2026-10-09)

- Versioned text-file previews expose capability-gated Rename, Move and Safe delete. Rename accepts a different safe single-component name; Move accepts only a different safe workspace-relative subdirectory (empty denotes the host-scoped default root). All operations pass `rootId=default`, the current subdirectory and the authoritative file `expectedVersion` to the exact native workbench command.
- Safe delete requires a separate explicit confirmation and uses only `workbench_safe_delete` (native trash) rather than permanent filesystem deletion. A response must explicitly acknowledge the requested action with `ok: true` and a new version; safe-delete also requires an acknowledged `trashId`. Error/409 and malformed responses preserve the current file and form without fake success.
- Native mutations are single-flight. While a native operation is pending, its controls are disabled and tab/path changes are blocked; concurrent or duplicate clicks cannot send another action. Successful operations refresh the trusted list and report the acknowledged operation. Changing the file or tab cancels uncommitted local intents. Unit-backed DOM smoke covers rename conflict/retry, safe relative move/traversal rejection, safe-delete two-click confirmation, stale-version payloads, in-flight lock and success reporting.

### Native single-file workspace uploads (2026-10-09)

- The Workspace file browser now offers a capability-gated native file chooser and an explicit Upload/Cancel staging step. Staged files stay local until the user clicks Upload. One non-empty file up to 5 MiB is accepted, filenames must be safe single components, and currently listed collisions are refused before transport. The native host remains the authority for write permissions, path scope and concurrent conflicts.
- Upload uses the existing `workbench_upload_file` command through `/api/workbench/upload` with the Studio-owned `default` root and current relative subdir; no external file transfer service. The upload bridge now requires an explicit native `ok: true` rather than treating missing ACK as success. The UI additionally requires an exact single-file result with the correct root/subdir/name and a non-empty returned version.
- In-flight native upload cannot be re-submitted, discarded or navigated away; stage and confirmed failure remain available for explicit retry. Successful upload refreshes the trusted file list and shows a server-acknowledged status. Switching tabs/directories before dispatch clears staged data; asynchronous responses after unmount are ignored. Studio bridge and DOM smoke tests cover missing ACK, staging, collisions, size limits, successful upload, rejected upload retry, duplicate-click lock and tab navigation protection.

### Native historical file restore with two-step confirmation (2026-10-09)

- The tracked File History snapshot view now exposes a native Restore action only when the host advertises `file_history_restore`. Users first select the exact file snapshot and view its historical content, then click Restore this snapshot and a separate Confirm restore. No mutation occurs on preview or the first confirmation click.
- The only mutation path is Studio's native `/api/file-history/restore` with the currently selected agentId and safe integer snapshotId. Completion requires explicit `ok: true` and a matching relPath (plus matching agentId when supplied); error or mismatched responses cannot claim success or replace the selected history snapshot.
- Restore requests are single-flight, disabling repeated restore and cancellation controls while pending; refresh/back/tab changes are blocked during a native restore. Session changes invalidate UI ownership so late responses cannot be rendered in the new session. After failure, the preview remains and the user must re-confirm; after acknowledged success, an explicit restore status replaces the action.
- DOM smoke covers capability gating, two-step confirmation, failure retaining snapshot and revoking confirmation, duplicate-call lock, tab-switch protection, and real acknowledgment. No cloud file restoration service is involved.

### Native checkpoint recovery controls (2026-10-09)

- The standalone Workspace rail now lists up to 100 valid, host-owned checkpoints with their recorded file path, ID and reason. Refresh, missing-capability states, malformed listing/errors and dispose-time stale-read isolation are explicit. No arbitrary absolute path checkpoint creation UI is exposed.
- A checkpoint can be restored or removed only using its native listed ID, never manually entered coordinates. Each action requires a separate confirmation, validates a matching native response (`ok: true` and exact restoredTo path / removed ID), rejects malformed ACKs and preserves the checkpoint listing/confirmation UX after failure. Native operations are single-flight, disabling cancellation, parallel actions and tab switches until completion; afterward a new host listing is fetched.
- All three checkpoint mutation adapter routes (create-user-edit, restore, remove) now require explicit `ok: true`, rather than assuming missing acknowledgment means success. Studio bridge and DOM smoke regressions cover this fail-closed behavior, restore failure/reconfirm, exact-ID commands, native remove confirmation, in-flight lock and stale listing cleanup.

### Session-scoped Jian local notes (2026-10-09)

- Jian drawer notes now auto-save to browser localStorage when permitted, keyed separately for the workspace and each selected chat session, with an in-process mirror as the fallback. The UI explicitly distinguishes durable browser-local saves from memory-only notes when sandbox storage is unavailable; it does not claim to save to the filesystem or an unsupported `/api/desk/jian` route.
- Session open/create/reset hydrates only that session's note, including restoration after panel remount. Notes have a hard 32,000-character cap, live count and session/workspace indicator, and Clear note requires two clicks; changing drawer state disarms the confirmation. An oversized input is truncated and the exact truncated value saved. Tests check storage success/failure, per-session isolation, remount, length limit and two-click clearing.
- `/notes` is a real local slash command that opens and focuses the right Jian drawer through an explicit shell callback (without sending any message to the LLM). Command help/capability gating and the host callback are covered by DOM smoke regression.

### Session-isolated in-memory composer drafts (2026-10-09)

- Each active conversation retains its unsent text in a per-panel, per-session in-memory map. Switching sessions hides the other conversation's text and restores the selected session's draft after its transcript opens; a failed open rehydrates the former session. No drafts are written to localStorage, remote backends or conversation transcripts. The UI explicitly labels retained drafts as local to the current running app.
- Composer content is capped to 50,000 characters. Successful local slash-command execution and the start of a deliberate chat send clear the current draft. Provider-selection or session-creation failures *before message dispatch* restore the unsent input for correction. Explicit New Chat clears the new-chat draft without erasing other sessions' unsent input. Retry actions refresh the composer state consistently.
- DOM regression covers two chat drafts, failed provider startup recovery, over-limit input, explicit New Chat clearing, status feedback and preservation of unrelated session drafts. Attachments remain managed separately and are never auto-reuploaded by text draft restoration.

### Workspace navigation and local folder filtering (2026-10-09)

- Workspace now renders clickable Root/ancestor breadcrumbs for each safe host-supplied relative path segment, allowing direct navigation without repeated Up clicks. They use the same native scoped list route and existing dirty-editor/active-mutation protection; paths are never supplied as arbitrary absolute host coordinates.
- Loaded directories are sorted folders-first with case-insensitive alphabetical file ordering. A separate local folder filter matches filenames without additional backend requests, shows `visible / total` and an explicit empty-match status, and supports Escape to clear. It is scoped to the current directory and cleared on navigation; global native workspace search remains a distinct command.
- DOM smoke covers sorting, case-insensitive filtering without transport calls, empty matches, Escape reset, nested ancestor breadcrumbs and direct return to root. The source directory response is sorted as a copy, not mutated.

### Phase A verified native-control bridge (2026-10-09; host work still blocked)

- The plugin requests explicit authenticated native control commands for session Thinking Level, session permission enforcement, session Memory, primary Agent selection and revisioned per-Agent config. Adapter endpoints validate target identities, enums, returned values, and config revision change; unacknowledged, stale or missing-host results are errors, not successful local overlays. The React iframe bridge intercepts the new session-memory endpoint as well.
- `/api/capabilities` only promotes Stage A flags after a separate native `get_agent_control_capabilities` acknowledgment with complete boolean fields; when the host is absent the flags remain false. A global provider/model read-only fallback is correctly labeled and must not masquerade as per-Agent config. Missing native commands degrade to `capability_unavailable` and are cached for the current Studio bridge binding.
- **Remaining / not yet functional:** The separately versioned `dsh-wasm-studio` host and `dsh-rs` driver lack these runtime controls. See `PHASE_A_NATIVE_CONTROLS.md` for the exact native implementation and test requirements. This plugin-only change is intentionally not called completion of the five Stage A features.

### Phase A host execution integration (2026-10-09)

- `dsh-wasm-studio` now implements the native command contract described in `PHASE_A_NATIVE_CONTROLS.md`, with durable `agent-controls.json` and per-Agent revisioned updates. The vendored `dsh-rs` reads live thinking/memory policy at model assembly and permission policy before tool dispatch; unsupported reasoning models fail safely.
- Legacy settings PUT is translated only for supported model/Memory/control fields using read-revision-then-CAS. Agent primary switching returns a real Studio Agent identity rather than the former fictional `studio` ID. Session switch reads actual native permission/Memory settings; the React Memory toggle waits for the native acknowledgment rather than changing the local store first.
- `ask` conservatively emits an approval-required tool result but no interactive approval grant flow is implemented; only operate/auto execute side-effectful tools. Memory retains manually provided per-Agent notes, not automatic cross-conversation memory. Upstream React TypeScript has unrelated pre-existing errors; the plugin JS suite and Studio Cargo tests cover the new control paths.

### Stage A closure: approval UX, cross-chat explicit memory, and build verification (2026-10-09)

- Native Studio pending tool approvals now suspend the exact Agent/tool/call/argument tuple at `dsh-rs` ToolRegistry. The user sees the complete (bounded) argument JSON in the right rail and explicitly approves twice or denies. Grants are one-use, scoped to the original Agent, and expire after 90 seconds. Cancellation, policy switch, duplicate decision, unknown ID and mutated tool arguments fail closed; unrelated tools are never unlocked.
- Per-Agent Memory settings now have a native, revision-aware editor. Notes can be enabled/disabled without fabricating success; conflicts preserve the draft. Shared Memory is **off by default** per Agent; after separately opting in to both native Memory and shared Memory, only user messages explicitly starting `请记住：`, `记住：`, `Remember:` or `remember:` create deduplicated durable shared facts. Other Agents must independently opt in to retrieve them. The right rail lists and offers two-click removal of shared facts; removal refreshes live prompt contexts. No LLM-driven unsolicited memory harvesting is enabled.
- The REST-like iframe bridge forwards and verifies the native `pending_tool_approvals`, `decide_tool_approval`, `list_shared_memory` and `delete_shared_memory` commands. DOM smoke covers retry/failure ACKs, double confirmation and shared-memory opt-in/deletion; native Rust tests check that a tool body cannot execute before one-time approval, and that disabled Memory never enters the model request. The React renderer production build and three TypeScript typecheck targets were verified; a physical installed-Studio GUI click-through remains a deployment acceptance task.

### Phase B: real Studio native integrations (2026-10-09)

- Native project folder/catalog CRUD and per-session project assignment now use Studio-owned persisted state with revision-checked CAS, replacing browser-only persistence when the updated host is available. Existing UI reorder, folder delete, project rename and session creation flows are supported through the same native contract. Browser-only catalogs require explicit migration if upgrading existing installs.
- Studio's scheduler handles `at`, `every` and five-field Cron in a fixed browser-provided UTC offset, persists next-run / last-run / errors and invokes the target live Agent through its real send-message entry point. The scheduler runs only while Studio is open, not as a background operating-system daemon; it does not silently change providers/models or execute arbitrary unsupported plugin actions.
- Vendored dsh-rs `bash` now runs inside a default-deny macOS OS sandbox for session-authorized roots and disallows unconfined fallback. With zero roots, on unsupported OSes or if the OS sandbox cannot execute, shell returns a denial instead of running unrestricted. A nested OS sandbox could not run under TUNL, so this still requires a real installed-app GUI/sandbox acceptance test.
- Session attachments are explicitly managed by their native per-session upload cache identity: list, validated read and double-confirmed deletion in the right rail. Cross-session path access, symlinks and arbitrary attachment IDs are rejected. Rust, browser bridge and rail DOM regressions cover key success/failure contracts.
- See `PHASE_B_NATIVE_INTEGRATIONS.md` for command-by-command integration, limits, and deployment checks.

### Phase C local reliability and migration (2026-10-09)

- GitHub Actions CI no longer triggers on pushes or pull requests; development checks run via the local Mac Runner only. The workflow file retains a manual-only entry that is not invoked by these iterations.
- Studio's Stage B scheduler now records separate attempt/success/error statuses, isolates invalid schedules, consumes due one-shot tasks without stopping other jobs, holds per-job execution permits across async sends, resumes persisted Agents when dispatching, and syncs state before atomic replacement. Jobs claimed just before a hard crash may be skipped to avoid duplicate agent prompts; there is no exactly-once distributed guarantee.
- The existing automation card exposes native error or completion status. A project migration preview/import interface moves legacy browser catalog and valid session assignments into an **empty** Studio native catalog after explicit two-click confirmation and CAS validation, retaining the original local browser copy.
- See `PHASE_C_LOCAL_RELIABILITY.md` for verification, operational limits, and deployment checks.
