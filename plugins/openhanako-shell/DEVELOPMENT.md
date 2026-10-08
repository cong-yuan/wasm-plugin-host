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
