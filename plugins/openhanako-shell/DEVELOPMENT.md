# openhanako-shell 开发路线

> 目标：把 OpenHanako 的核心聊天体验可靠地接到 Studio backend。原则是优先接真实能力；底层没有的能力必须 fail-closed，不能用“假成功”掩盖缺口。

## 当前状态

已经完成的主链路：

- 会话列表 / 新建 / 切换 / 恢复
- 流式 thinking / text / tool 事件
- 模型列表、默认模型与会话内模型切换
- archive / restore / rename / delete
- pin / pin-order / session projects（当前为本地持久化）
- 用户资料、appearance、sidebar UI、quick chat、notifications（当前为本地持久化）
- automation 草稿 CRUD；Studio 无 scheduler 时明确拒绝启用
- 权限模式在 Studio 无底层控制命令时 fail-closed 到 `ask`

## Phase 1 — Core Chat Completion

目标：把日常会话操作补齐，避免核心聊天动作掉回 Hana Server 或 soft stub。

当前推进顺序：retry/fork 已完成，下一项进入 fresh compact / cleanup / todo complete。

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
   - `/api/sessions/fresh-compact`：Studio 当前没有会话摘要/压缩原语，已从 soft-success 改为 `capability_unavailable`，等待宿主命令。
   - `/api/sessions/todos/complete`：Studio 当前没有持久化 todo mutation 原语，已从 soft-success 改为 `capability_unavailable`；UI 只有后端真实成功才清本地 todo，避免刷新后复活。

3. **Search / summary / authorized folders / continue-deleted-agent** — P1 / 部分完成
   - `/api/sessions/search`：已纳入 Studio iframe bridge；adapter 复用稳定的 title/content 两阶段搜索、transcript cache、limit 上限和已删除/归档过滤。
   - `/api/sessions/summary`：Studio 当前没有持久化 summary 原语，已纳入 bridge 并返回 `capability_unavailable`，不再掉回 Hana Server 产生错误或假数据。
   - `/api/sessions/authorized-folders`：Studio 当前没有 session folder-scope 持久化原语，已纳入 bridge 并对 GET/PATCH fail closed；不能把“显示的授权目录”伪装成真正的工具访问控制。
   - `/api/sessions/continue-deleted-agent`：OpenHanako 需要“删除 Agent → 用 primary Agent 新建会话 → 迁移 transcript → 可选 compact”的专用生命周期语义；Studio 目前没有 deleted-agent/agent replacement 原语，继续保持 fail closed。

## Phase 2 — Model & Input

- `/api/preferences/models`：GET 已读取 Studio `get_llm_config` 的当前 provider/model；全局 utility/search/vision 等 OpenHanako 专属配置仍未有等价 Studio 持久化语义，后续需要单独补 capability，而不是把 current model 冒充 utility model。
- `/api/session-thinking-level`：已从固定 `off` 改为显式 `medium + locked + capability_unavailable`，避免 UI 误以为 Studio 支持切换；宿主补真实 session thinking 原语后再接。
- 接 `/api/upload-blob`、附件、图片和 vision 路径；当前 Studio 没有 blob/file-ingest command，继续保持 fail closed。
- `/api/models/auxiliary-vision` 改为真实 capability projection；当前 Studio 模型列表没有输入模态元数据，暂保持 unavailable。

## Phase 3 — Studio-native Agent

- 多 Agent 列表：GET `/api/agents` 已改为读取 Studio session registry 的 live rows，不再固定返回一个 Hanako；当前没有可信的 primary-agent 原语，因此单 Agent 时标 primary，多 Agent 时仅按 Studio 返回顺序给出临时 primary 标记，后续应接正式 primary 选择。
- agent switch：Studio 当前没有 primary-agent switch 命令，已改为带 `capability_unavailable` 的 fail-closed 响应，不伪造切换成功。
- agent config：目前只保留最小兼容投影，真实 per-agent config 持久化仍待宿主能力。
- permission mode / read-only / operate / auto：继续保持 `ask` locked，待宿主控制面。
- 对 Studio backend 缺失的控制面先补宿主命令，再接 UI。

## Phase 4 — Workspace

- authorized folders
- project / workspace mapping
- file / workbench / preview
- 把当前重要的 localStorage 状态逐步迁到 Studio 持久层。

## Phase 5 — Extended Hana

按实际需求逐项决定哪些继续由 Hana Server 提供、哪些映射到 Studio：

- automation scheduler
- MCP / connectors
- plugins / widgets / pages
- channels / DM
- memories
- browser
- skills
- media / image / video
- resource-io / checkpoints / file history

## 接线原则

1. 核心会话语义必须真实：retry/fork/archive/delete 等不能 fake success。
2. UI 状态与 Studio 状态只有一个 source of truth；本地兼容存储必须在文档中明确标注。
3. 新增 bridge endpoint 时必须有：正常路径、非法输入、底层 capability 缺失、刷新/历史 hydration 回归测试。
4. 跨仓能力优先在 Studio 暴露最小稳定 Tauri command，再由 `js/lib/api.js` 和 `hana-adapter.js` 投影成 OpenHanako API。
