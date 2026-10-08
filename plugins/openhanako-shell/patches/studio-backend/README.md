# studio-backend — iframe chat → Studio Tauri agents

These files are copied into the live openhanako extract
(`ui/`). They do not replace the upstream client. When the
page is iframed by `openhanako-shell`, they handshake with the parent and
forward the chat slice. A standalone `dev:web` window (no parent hello) keeps
talking to the Hana server.

## Re-apply

`patches/studio-slots/App.tsx` already mounts `<StudioBackendBridge />`.
Copy this folder **before** (or together with) that App.tsx, or the import
fails.

```bash
ROOT=plugins/openhanako-shell/ui/desktop/src/react
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

The checked-in patch copy is intentionally kept byte-for-byte identical to `ui/desktop/src/react/studio-backend/studio-backend-bridge.ts`; `studio-backend-patch-sync.test.mjs` fails if the two drift. Workbench, file-history, ResourceIO core operations, and generated-resource preview are capability-gated: a route is intercepted only when its exact native command is advertised, so partial host upgrades do not steal unsupported legacy operations. ResourceIO watch/subscription/event endpoints and resource ticket issuance remain on Hana until their long-lived ownership/security model has a native host equivalent.

### Native workbench command contract

The parent/Studio host owns filesystem authority. These native workbench commands receive only logical workspace coordinates and must enforce the authorized root/mount before touching disk:

- `workbench_list_files({ rootId, subdir })` → `{ rootId, mountId, mount, subdir, files }`
- `workbench_search_files({ rootId, query })` → `{ rootId, mountId, mount, query, results }`
- `workbench_read_file({ rootId, subdir, name })` → `{ exists, content, version, etag, mimeType, size, mtimeMs, filename }`
- `workbench_write_file({ rootId, subdir, name, content, expectedVersion, mustNotExist })` → `{ ok, version, files }`
- `workbench_rename_file({ rootId, subdir, oldName, newName, expectedVersion })` → `{ ok, version, files }`
- `workbench_move_file({ rootId, subdir, name, destSubdir, expectedVersion })` → `{ ok, version, files }`
- `workbench_safe_delete({ rootId, subdir, name, expectedVersion })` → `{ ok, version, trashId, files }`
- `workbench_upload_file({ rootId, subdir, name, base64Data, mimeType, expectedVersion })` → `{ ok, version, name, size, files }`

### Native file history / ResourceIO / resource preview command contract

File history commands receive an `agentId` and must resolve the tracked workspace on the host; they must not accept an arbitrary filesystem root from the iframe:

- `file_history_list_files({ agentId })` → `{ files }`
- `file_history_list_versions({ agentId, relPath })` → `{ versions }`
- `file_history_get_snapshot({ agentId, snapshotId })` → `{ relPath, capturedAt, origin, content }`
- `file_history_restore({ agentId, snapshotId })` → `{ ok, relPath }`

Checkpoint commands keep the checkpoint directory on the host and expose only safe IDs / explicit edit reasons to the iframe:

- `checkpoint_list({})` → `{ checkpoints }`
- `checkpoint_create_user_edit({ filePath, reason })` → `{ ok, checkpoint }`
- `checkpoint_restore({ id })` → `{ ok, restoredTo }`
- `checkpoint_remove({ id })` → `{ ok, id }`

The bridge validates `filePath` as absolute and `reason` as `edit-start` / `autosave-interval`; checkpoint IDs are restricted to a path-safe token. The host must additionally enforce the authenticated workspace/session scope before reading or writing checkpoint data.

MCP connector configuration remains Hana-owned. `GET /api/mcp/connectors/export` (and legacy `/api/mcp/servers/export`) returns a schema-versioned, redacted configuration suitable for copy/import. Credentials, env/header values, runtime state, and discovered tools are intentionally omitted; credentials must be entered again after import.

ResourceIO core commands receive logical resource references. `operationContext` is audit metadata only; host authorization must come from the authenticated plugin/session binding, not from `principal` or identity fields supplied by iframe JSON:

- `resource_io_stat({ resource })` → ResourceIO stat result
- `resource_io_read({ resource, encoding })` → `{ ...readResult, encoding }`
- `resource_io_list({ resource })` → ResourceIO list result
- `resource_io_search({ resource, query })` → ResourceIO search result
- `resource_io_write({ resource, content, encoding, operationContext })` → versioned write result
- `resource_io_write_expected_version({ resource, content, encoding, expectedVersion, operationContext })` → versioned write result or `{ ok:false, conflict:true, ... }`
- `resource_io_rename({ from, to, operationContext })` → rename result
- `resource_io_move({ from, to, operationContext })` → move result
- `resource_io_trash({ resource, trash, operationContext })` → recoverable trash result

Generated/session resource preview uses two commands:

- `resource_get_metadata({ resourceId })` → the existing resource envelope
- `resource_read_content({ resourceId })` → `{ exists, mime, size, etag, filename, contentBase64 }`

The bridge converts `contentBase64` into the browser `Response` body, preserving MIME, length, ETag and `HEAD` semantics. Ticketed `/api/resources/:resourceId/content?ticket=...` requests intentionally bypass the native preview path so Hana's existing ticket verification remains authoritative.

Checkpoint route IDs are validated before the native command and the local `CheckpointStore` repeats the same validation before constructing filesystem paths. Restore refuses to write through a symbolic link. The existing `PreviewEditor` checkpoint caller continues to use the same HTTP surface, so standalone Hana behavior and native-host behavior share one contract.

`workbench_read_file` is text-only in this native slice; the bridge preserves the response as a raw UTF-8 `Response` body and carries `Content-Type`, `Content-Length`, `ETag`, and file metadata headers. `HEAD` returns the same metadata without a body. `workbench_safe_delete` must use the host's recoverable-trash/checkpoint mechanism rather than a permanent unlink. Upload accepts the same base64 payload shape as the existing mobile workbench endpoint; the host must enforce the workspace scope and the existing per-file size limit before writing.

When the parent hello has no `backendCommands` field, workbench interception stays disabled for backwards compatibility. The hello may provide the list as `backendCommands` or `backend_commands`; `capabilities.backendCommands` and `capabilities.backend_commands` are also accepted.

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
