# Settings UI tweaks (vs upstream openhanako)

Applied on the live vite tree under `/tmp/openhanako-full` for HMR.

## Scope

These patches only touch **settings chrome** (dialog shell, title row, left nav, right pane layout/scroll). They do **not** change editor/chat typography.

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
