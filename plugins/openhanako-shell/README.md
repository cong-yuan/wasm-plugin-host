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

另外几条只为了让 `initApp` 在没有 Hana API 时也能走到 `loadSessions`：`GET /api/server/identity`、`GET /api/models`、`POST /api/ws-ticket`、`GET /api/agents/:id/config`、`GET /api/preferences/session-permission-default`。它们不是 agent 协议。

会话周边会 404 的表面（archive/pin/rename、user-profile、desk/cron、preferences/models 等）由 shim 返回空/`{ ok: true }` 软桩，避免 harness 控制台噪音；不实现真实行为。

## 跑起来

```bash
# 1) 上游 UI。槽位补丁和后端补丁一起拷。
ROOT=/tmp/openhanako-full/desktop/src/react
cp -R plugins/openhanako-shell/patches/studio-slots/studio-slots "$ROOT/"
cp plugins/openhanako-shell/patches/studio-slots/App.tsx "$ROOT/App.tsx"
cp plugins/openhanako-shell/patches/studio-slots/components/app/*.tsx "$ROOT/components/app/"
cp plugins/openhanako-shell/patches/studio-slots/components/InputArea.tsx "$ROOT/components/InputArea.tsx"
cp plugins/openhanako-shell/patches/studio-slots/components/PreviewPanel.tsx "$ROOT/components/PreviewPanel.tsx"
mkdir -p "$ROOT/studio-backend"
cp plugins/openhanako-shell/patches/studio-backend/studio-backend-bridge.ts "$ROOT/studio-backend/"
cp plugins/openhanako-shell/patches/studio-backend/StudioBackendBridge.tsx "$ROOT/studio-backend/"

cd /tmp/openhanako-full && npm run dev:web   # 或项目惯用脚本，默认 http://127.0.0.1:5173

# 2) wasm
cargo build -p openhanako-shell -p demo-openhanako-addon --release --target wasm32-wasip1

# 3) Studio 启用 openhanako-shell（+ 可选 demo-openhanako-addon）
#    启动窗会加载 iframe。父页面 hello 之后：侧栏会话来自 list_sessions，
#    发送一条消息会等 send_message，再在对话里出现助手回复。
```

重新打补丁时重复上面的 `cp`。细节分文件写在 `patches/studio-slots/README.md` 和 `patches/studio-backend/README.md`。

设置相关补丁仍在 `patches/` 根下（Settings* / InputArea 首屏等），与槽位桥、后端桥独立。

## 槽位

槽锚点在原 UI 真实 chrome 上（`data-ohk-slot`），不是猜坐标的外层 overlay。空槽不抢点击。`openhanako.*` 与 `hana-shell` 的 `hana.*` 分开。Rust `SLOTS` 这条切片没有改。

上游自带的 page / widget / card 插件岛仍保留；`openhanako.*` 是 Studio WASM 的 chrome 扩展面。

## 不在这条切片里

完整 Hana WS 事件、文件/书桌/预览、LlmService、拆掉手写壳、云端 openhanako。
