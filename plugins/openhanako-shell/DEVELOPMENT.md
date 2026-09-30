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

3. **Search / summary / authorized folders / continue-deleted-agent** — P1
   - `/api/sessions/search`
   - `/api/sessions/summary`
   - `/api/sessions/authorized-folders`
   - `/api/sessions/continue-deleted-agent`

## Phase 2 — Model & Input

- 把 `/api/preferences/models` 从默认模型 soft stub 接到 Studio LLM 配置。
- 把 `/api/session-thinking-level` 从固定 `off` 接到真实模型/会话能力；底层不支持时显式 locked。
- 接 `/api/upload-blob`、附件、图片和 vision 路径。
- `/api/models/auxiliary-vision` 改为真实 capability projection。

## Phase 3 — Studio-native Agent

- 多 Agent 列表与 primary agent
- agent switch
- agent config
- permission mode / read-only / operate / auto
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
