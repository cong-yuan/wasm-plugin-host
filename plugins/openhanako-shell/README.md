# openhanako-shell

Studio 启动窗里嵌 **真实 openhanako 前端**（iframe），并声明 WASM 槽位表面。聊天垂直切片走父页面里的 Tauri agent 命令：iframe 跨源，不能自己 `invoke`。

## 架构

```
Studio 主 webview                         openhanako iframe (127.0.0.1:5173)
entry.js
  ├─ lib/bridge.js          ← geometry ─  StudioSlotBridge
  └─ lib/host-bridge.js     ← postMessage ─ studio-backend-bridge.ts
        └─ lib/hana-adapter.js
              └─ lib/api.js
                    └─ lib/tauri-invoke.js
                          window.__TAURI__.core.invoke
                          / __TAURI_INTERNALS__.invoke
```

父页面在 iframe 创建后立刻、以及每 2 秒发一次：

```json
{ "source": "openhanako-shell", "type": "studio-backend-hello" }
```

iframe 也用 `{ "source": "openhanako-studio-bridge", "type": "hello" }` 探测。握手成功后，它只拦截下面这张表里的 HTTP / `/ws`；其余请求仍进 Hana 自己的服务。没有 hello（单独开 vite）时不拦截。

请求：

```json
{ "source": "openhanako-studio-bridge", "type": "request", "requestId": "sb-1", "op": "http|ws", "...": "..." }
```

响应（同一个 `requestId`）：

```json
{ "source": "openhanako-shell", "type": "response", "requestId": "sb-1", "ok": true, "result": {} }
```

`AgentRow.id` 就是 openhanako 的 `sessionId`。路径固定成 `studio://<id>`，因为上游用 `sessionPath` 做转录键。助手 id 恒为 `studio`（名字 Hanako），避免每个会话被当成另一个助手。

`create_agent` 默认 `provider: "mock"`、`model: "mock-1"`（与 Studio 离线演示一致），写在 `js/lib/api.js` 顶部的 `DEFAULT_PROVIDER` / `DEFAULT_MODEL`。Studio 的 `send_message` 本身会 `await when_idle`（没有 Tauri token 事件）；桥在 invoke 进行中轮询 `transcript`（已修 A1+A2：不再 fallback 到上一轮 assistant），把助手文本/reasoning 的增长实时推成 `text_delta` / `thinking_*`（父→iframe 的 `{ type: "event" }`），结束后再 `turn_end`。

当前窗口没有 Tauri invoke 时，`lib/api.js` 退回内存 fixture，`mode()` 为 `"mock"`，健康检查里的 `studioBridge` 同样是 `"mock"`。invoke 一旦存在，命令失败会抛错，不会再假装有会话。

手写壳（`js/shell.js` + `js/panels/*`）走同一个 `lib/api.js`。启动窗实际挂的是 iframe，不是这套壳。

## 垂直切片契约

| Hana 表面 | Studio 命令 | 说明 |
|---|---|---|
| `GET /api/health` | — | `{ status: "ok", studioBridge: "tauri"\|"mock", agent: "Hanako" }`，让连接初始化继续 |
| `GET /api/config` | — | `{ locale: "zh-CN" }` |
| `GET /api/agents` | — | 单个助手 `{ id: "studio", name: "Hanako", isPrimary: true }` |
| `GET /api/sessions` | `list_sessions`（失败再 `list_agents`） | `AgentRow` → `{ path: "studio://id", sessionId, title, firstMessage, messageCount, agentId: "studio" }` |
| `POST /api/sessions/new`、`/new-detached` | `create_agent { provider, model, cwd: null, id: null }` | 返回 `{ path, sessionId, agentId: "studio" }`，`ensureSession` 要这三个字段 |
| `POST /api/sessions/switch` | 若 `live === false` 则 `resume_session { sessionId }` | `{ sessionId, isStreaming: false, agentId: "studio" }` |
| `GET /api/sessions/messages?path=&sessionId=` | `transcript { agentId }` | `{ messages: [{ role, content, thinking? }], hasMore: false }`。`content` 是 `ChatMessage.text` |
| `POST /api/sessions/turns/retry` | `retry_session_turn { sessionId, target, replacementText?, msgId? }` | 使用历史投影里的稳定 `studio-entry:<index>:<role>` target；宿主缺命令时 fail-closed，不回落到 Hana Server |
| `POST /api/sessions/fork` | `fork_session { sessionId, target }` | 目标语义由 Studio 基于 dsh session event boundary 实现；返回新的 `studio://<childId>` |
| `GET/PUT /api/preferences/session-permission-default`、`/api/session-permission-mode` | — | Studio 当前没有底层权限模式命令，因此 fail-closed 固定为 `ask`，写请求返回 `locked: true`，避免 UI 假装进入 `auto`/`operate`/`read_only` |
| `GET/PUT /api/preferences/appearance` | — | theme / serif / paperTexture / leavesOverlay 本地持久化；校验主题 id 与布尔字段，兼容旧 `claude-design` → `new-warm-paper` |
| `GET/PUT /api/preferences/sidebar-ui` | — | projectView 折叠/展开集合与 sessionList 行模式本地持久化；沿用上游去重、长度/数量边界和 `single-line` / `two-line` 约束 |
| `GET/PUT /api/preferences/quick-chat` | — | 快速聊天 shortcut 与 reuseTimeoutMinutes 本地持久化；沿用上游快捷键标准化和 0–120 分钟边界 |
| `GET/PUT /api/preferences/notifications` | — | chatCompletion / scheduledTaskCompletion / patrolCompletion 本地持久化；沿用上游通知模式枚举和旧 `turnCompletion` 兼容字段 |
| WS `{ type: "prompt", text, sessionId, sessionPath, clientMessageId }` | `send_message { agentId, text, msgId }` | 见下方入站事件 |
| WS `{ type: "interject", ... }` | `steer_agent { agentId, text, msgId }` | 与 `send_message` 同参；缺 `msgId` 会在 Studio 侧失败 |
| WS `{ type: "abort", sessionId, sessionPath }` | `cancel_agent { agentId }` | 随后 `turn_end` + `status isStreaming: false` |
| WS `context_usage` / `resume_stream` | — | 空事件，避免重连循环 |

父页面在 turn 进行中通过 `{ type: "event", requestId, event }` 推送（最终 `response` 的 `events` 为空，避免重放）：

| 事件 | 作用 |
|---|---|
| `{ type: "status", isStreaming: true, sessionPath, sessionId }` | `applyStreamingStatus` / `beginTurn`（立刻） |
| `{ type: "session_user_message", sessionPath, clientMessageId, message: { text } }` | 确认乐观用户气泡（立刻） |
| `thinking_start` / `thinking_delta` / `thinking_end` | `transcript.reasoning` 增长时 |
| `{ type: "text_delta", sessionPath, delta }` | `StreamBufferManager` 追加；轮询到增量就推，不整段等待 |
| `{ type: "turn_end", sessionPath }` | `send_message` 返回后 |
| `{ type: "status", isStreaming: false, sessionPath, sessionId }` | 结束 streaming |

另外几条只为了让 `initApp` 在没有 Hana API 时也能走到 `loadSessions`：`GET /api/server/identity`、`GET /api/models`、`POST /api/ws-ticket`、`GET /api/agents/:id/config`。权限模式端点虽然也由 bridge 接管，但在 Studio 暂无可执行的权限控制命令时会明确锁定为 `ask`，而不是伪造成功。它们不是 agent 协议。

会话的 archive/restore/rename/delete 已由 Studio bridge 实现：archive 通过 `soft_unbind_agent` 保留历史并写入本地归档元数据，restore 重新 `resume_session`，rename 只接受真实活动会话或已归档会话，永久删除才会 dispose agent。用户名、个人简介、外观偏好、侧边栏 UI、快速聊天与通知偏好分别通过 `/api/config`、`/api/user-profile`、`/api/preferences/appearance`、`/api/preferences/sidebar-ui`、`/api/preferences/quick-chat`、`/api/preferences/notifications` 保存到本地 `localStorage`；agent config、health 与 server identity 读取同一份用户名。`/api/desk/cron` 现在持久化可编辑的本地自动化草稿（add/update/remove），但 Studio 尚无调度执行器，因此所有草稿强制保持 disabled，启用和 apply_suggestion 都返回 `scheduler_unavailable`，不会伪造定时任务已经生效。归档 cleanup 会按 `archivedAt` 和 `maxAgeDays` 真正永久删除过期会话；`fresh-compact` 与 `todos/complete` 在 Studio 尚无对应持久化原语时返回 `capability_unavailable`，不再假成功。其余仍会 404 的周边表面（preferences/models 等）由 shim 返回空/最小兼容结果，避免 harness 控制台噪音；不伪造未接能力。`/api/sessions/pin` 与 `/api/sessions/pin-order` 以及 `/api/session-projects*` 同样在本地 `localStorage` 持久化（Studio 无上游等价 API）。

## 前端来源

Hana 前端已经迁进本插件的 `ui/`，不再依赖外部 `openhanako` / `openhanako-ui` 克隆。
`patches/` 只是 Studio 相关改动的快照，方便对照；**日常改前端直接改 `ui/`**。

基于 [liliMozi/openhanako](https://github.com/liliMozi/openhanako)（Apache-2.0）快照，此后在本仓库内演进。

开发阶段、未接能力和优先级见 [`DEVELOPMENT.md`](./DEVELOPMENT.md)。

## 跑起来

**推荐：UI + Studio 一起开**

```bash
# 在仓库根或本插件目录
bash plugins/openhanako-shell/scripts/dev-with-studio.sh
# 或
npm --prefix plugins/openhanako-shell run dev:with-studio
```

脚本会：若 `127.0.0.1:5173` 还没起来就后台启动 `ui/` 的 `npm run dev:web`，再启动 `dsh-wasm-studio`（`tauri dev`）。Studio iframe 默认加载 `http://127.0.0.1:5173/index.html`，两者本来就可以同时跑；白屏通常只是只开了 Studio、没开 UI。

只起 UI：

```bash
bash plugins/openhanako-shell/scripts/dev-ui.sh
# 或
cd plugins/openhanako-shell/ui && npm run dev:web
```


## 槽位

槽锚点在原 UI 真实 chrome 上（`data-ohk-slot`），不是猜坐标的外层 overlay。空槽不抢点击。`openhanako.*` 与 `hana-shell` 的 `hana.*` 分开。Rust `SLOTS` 这条切片没有改。

上游自带的 page / widget / card 插件岛仍保留；`openhanako.*` 是 Studio WASM 的 chrome 扩展面。

## 不在这条切片里

完整 Hana WS 事件、文件/书桌/预览、LlmService、拆掉手写壳、云端 openhanako。
