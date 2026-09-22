# studio-backend — iframe chat → Studio Tauri agents

These files are copied into the live openhanako extract
(`/tmp/openhanako-full`). They do not replace the upstream client. When the
page is iframed by `openhanako-shell`, they handshake with the parent and
forward the chat slice. A standalone `dev:web` window (no parent hello) keeps
talking to the Hana server.

## Re-apply

`patches/studio-slots/App.tsx` already mounts `<StudioBackendBridge />`.
Copy this folder **before** (or together with) that App.tsx, or the import
fails.

```bash
ROOT=/tmp/openhanako-full/desktop/src/react
PATCH=plugins/openhanako-shell/patches/studio-backend
mkdir -p "$ROOT/studio-backend"
cp "$PATCH/studio-backend-bridge.ts" "$ROOT/studio-backend/studio-backend-bridge.ts"
cp "$PATCH/StudioBackendBridge.tsx" "$ROOT/studio-backend/StudioBackendBridge.tsx"
# App.tsx mount lives in patches/studio-slots/App.tsx:
cp plugins/openhanako-shell/patches/studio-slots/App.tsx "$ROOT/App.tsx"
```

Restart Vite or rely on HMR after copy.

## What the shim intercepts

Only after `{ source: 'openhanako-shell', type: 'studio-backend-hello' }`.

| Hana surface | Parent op |
|---|---|
| `GET /api/health`, `GET /api/config`, `GET /api/agents` | `op: 'http'` |
| `GET /api/sessions` | list |
| `POST /api/sessions/new` and `/new-detached` | create |
| `POST /api/sessions/switch` | resume when `live === false` |
| `GET /api/sessions/messages?path=&sessionId=` | transcript |
| `WebSocket /ws` `{ type: 'prompt' \| 'interject' \| 'abort' }` | `op: 'ws'` |

Bootstrap-only (so `initApp` reaches the session list without a Hana API):
`GET /api/server/identity`, `GET /api/models`, `POST /api/ws-ticket`,
`GET /api/agents/:id/config`, `GET /api/preferences/session-permission-default`.

Everything else is passed through to `fetch` / the real `WebSocket`.

Inbound WS events the shim pushes after `send_message` returns (one full
turn, not a token stream):

1. `status` `{ isStreaming: true, sessionPath, sessionId }`
2. `session_user_message` `{ sessionPath, message: { text, clientMessageId } }`
3. optional `thinking_start` / `thinking_delta` / `thinking_end` when Studio returns `reasoning`
4. `text_delta` `{ sessionPath, delta }` — StreamBufferManager appends assistant text from `delta`
5. `turn_end` `{ sessionPath }`
6. `status` `{ isStreaming: false, sessionPath, sessionId }`

`sessionPath` is `studio://<AgentRow.id>`. `sessionId` is that same id.
