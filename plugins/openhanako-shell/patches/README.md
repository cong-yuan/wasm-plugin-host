# Patches applied onto the live openhanako vite tree

Applied under `/tmp/openhanako-full` for HMR.

| Folder | Purpose |
|---|---|
| `patches/` root (Settings*, InputArea, ChatPage) | Settings chrome + first-paint input fix |
| `patches/studio-slots/` | `data-ohk-slot` anchors + geometry bridge |
| `patches/studio-backend/` | iframe chat → Studio Tauri agents (HTTP/WS shim) |

See each folder's README for re-apply commands. Slot and backend patches
both touch `App.tsx` (via `studio-slots/App.tsx`); copy them together.

## Settings UI tweaks (this folder)

These root files only touch **settings chrome** (dialog shell, title row, left nav, right pane layout/scroll). They do **not** change editor/chat typography.

- Editor markdown sizes live under `--editor-markdown-*` (Interface tab → typography editor).
- Settings chrome uses global UI tokens `--fs-title|body|ui|caption|hint` from `styles.css`.

## Current tweaks

- Shorter settings **title row** (~36px), not dialog height
- Dialog shell mid height (~640px), fixed width; simple tabs content column max ~560px
- Left nav: search pinned; list below scrolls; **no visible left scrollbar**
- Right main: extra top padding so fade does not cover first rows; stable thin scrollbar (no dual-scroll flash)

## Re-apply

Copy onto the extract:

- `Settings.module.css` → `desktop/src/react/settings/`
- `SettingsContent.tsx` → `desktop/src/react/settings/`
- `SettingsNav.tsx` → `desktop/src/react/settings/`
- `SettingsModalShell.module.css` → `desktop/src/react/components/`
- `SettingsModalShell.tsx` → `desktop/src/react/components/`


## Typography mapping (settings chrome)

Uses global `--fs-*` tokens only — independent of Interface → editor markdown (`--editor-markdown-*`).

| Role | Token |
|------|-------|
| Header / current tab name | `--fs-ui` |
| Left nav item | `--fs-caption` |
| Right tab / section title | `--fs-title` |
| Row label | `--fs-ui` |
| Hint / description | `--fs-hint` |
| Inputs / controls | `--fs-caption` |

Also copy `settings-components.module.css` → `desktop/src/react/settings/components/`.

## Input area first-paint crash

Desktop TipTap previously used `immediatelyRender: true`, which can throw on first paint and trip `RegionalErrorBoundary` around the input (`此区域暂时无法显示`).

- `InputArea.tsx` → `desktop/src/react/components/` — `immediatelyRender: false` for all surfaces
- `ChatPage.tsx` → `desktop/src/react/components/app/` — desktop also gets `autoRetry` like mobile
