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
| `/api/session-projects*` | local project catalog |
| `WebSocket /ws` `{ type: 'prompt' \| 'interject' \| 'abort' }` | `op: 'ws'` |

Bootstrap-only (so `initApp` reaches the session list without a Hana API):
`GET /api/server/identity`, `GET /api/models`, `POST /api/ws-ticket`,
`GET /api/agents/:id/config`, `GET /api/preferences/session-permission-default`.

Everything else is passed through to `fetch` / the real `WebSocket`.

Inbound WS events are pushed as `{ type: 'event', requestId, event }` while
`send_message` is in flight (Studio has no token Tauri channel; the parent
polls `transcript` for growth). Final `response` carries `{ streamed: true, events: [] }`.

1. `status` `{ isStreaming: true, … }` — immediately
2. `session_user_message` — immediately
3. optional `thinking_*` as `reasoning` grows
4. `text_delta` `{ delta }` as assistant text grows
5. `turn_end` after invoke resolves
6. `status` `{ isStreaming: false, … }`

Handshake: chat `/ws` always uses the StudioSocket shim inside the iframe
(never the native WebSocket to the dummy `getServerPort` while hello is pending).

`sessionPath` is `studio://<AgentRow.id>`. `sessionId` is that same id.
