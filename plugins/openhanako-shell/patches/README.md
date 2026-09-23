# Patches（快照）

前端源码已迁到 `plugins/openhanako-shell/ui/`。**以 `ui/` 为准**；本目录保留 Studio 相关改动的对照快照，不再假设外部 `/tmp/openhanako-full` 或单独的 openhanako 克隆。

| Folder | Purpose |
|---|---|
| `patches/` root (Settings*, InputArea, ChatPage) | Settings chrome + first-paint input fix |
| `patches/studio-slots/` | `data-ohk-slot` anchors + geometry bridge |
| `patches/studio-backend/` | iframe chat → Studio Tauri agents (HTTP/WS shim) |

日常开发：直接改 `ui/`。只有需要把快照重新压进 `ui/` 时才跑各子目录 README 里的 `cp`（目标为 `ui/desktop/src/react`）。

## Settings UI tweaks (this folder)

These root files only touch **settings chrome** (dialog shell, title row, left nav, right pane layout/scroll). They do **not** change editor/chat typography.

- Editor markdown sizes live under `--editor-markdown-*` (Interface tab → typography editor).
- Settings chrome uses global UI tokens `--fs-title|body|ui|caption|hint` from `styles.css`.

## Current tweaks

- Shorter settings **title row** (~36px), not dialog height
- Dialog shell mid height (~640px), fixed width; simple tabs content column max ~560px
- Left nav: search pinned; list below scrolls; **no visible left scrollbar**
- Right main: extra top padding so fade does not cover first rows; stable thin scrollbar (no dual-scroll flash)

## Sync into `ui/` (optional)

Copy onto the owned tree:

- `Settings.module.css` → `ui/desktop/src/react/settings/`
- `SettingsContent.tsx` → `ui/desktop/src/react/settings/`
- `SettingsNav.tsx` → `ui/desktop/src/react/settings/`
- `SettingsModalShell.module.css` → `ui/desktop/src/react/components/`
- `SettingsModalShell.tsx` → `ui/desktop/src/react/components/`

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

Also copy `settings-components.module.css` → `ui/desktop/src/react/settings/components/`.

## Input area first-paint crash

Desktop TipTap previously used `immediatelyRender: true`, which can throw on first paint and trip `RegionalErrorBoundary` around the input (`此区域暂时无法显示`).

- `InputArea.tsx` → `ui/desktop/src/react/components/` — `immediatelyRender: false` for all surfaces
- `ChatPage.tsx` → `ui/desktop/src/react/components/app/` — desktop also gets `autoRetry` like mobile

## LLM model fetch / session picker (2026-09-23)

- `settings/tabs/providers/ProviderModelList.tsx` — loading on 读取模型 + trailing 可用（n）
- `settings/fetch-models-ui.css` — append into `Settings.module.css`
- `components/input/ModelSelector.tsx` — refresh button at top of popup (does not close)
- `ui/SelectWidget.tsx` + `ui/SelectWidget.module.css` — `renderPopupHeader` support
