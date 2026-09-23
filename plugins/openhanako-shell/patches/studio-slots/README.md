# studio-slots — mount WASM slots in the real openhanako UI

These files replace the corresponding paths under
`desktop/src/react/` in the live extract (`ui/`).

## Idea

1. Real chrome nodes get `data-ohk-slot="openhanako.…"` (titlebar, sidebar,
   conversation, preview, rail, shell overlay).
2. `StudioSlotBridge` posts their `getBoundingClientRect()` to the parent.
3. `openhanako-shell` positions `studio.renderSlot` hosts on those rects.

Studio inject components still run in the parent (they need `studio.*`); the
anchors live in the original UI so placement tracks real layout.

## Re-apply

`App.tsx` also mounts `StudioBackendBridge`. Copy `patches/studio-backend/`
into `desktop/src/react/studio-backend/` in the same pass, or the import
does not resolve. See `patches/studio-backend/README.md`.

```bash
ROOT=plugins/openhanako-shell/ui/desktop/src/react
PATCH=plugins/openhanako-shell/patches/studio-slots
cp -R "$PATCH/studio-slots" "$ROOT/"
cp "$PATCH/App.tsx" "$ROOT/App.tsx"
cp "$PATCH/components/app/"*.tsx "$ROOT/components/app/"
cp "$PATCH/components/InputArea.tsx" "$ROOT/components/InputArea.tsx"
cp "$PATCH/components/PreviewPanel.tsx" "$ROOT/components/PreviewPanel.tsx"
mkdir -p "$ROOT/studio-backend"
cp plugins/openhanako-shell/patches/studio-backend/studio-backend-bridge.ts "$ROOT/studio-backend/"
cp plugins/openhanako-shell/patches/studio-backend/StudioBackendBridge.tsx "$ROOT/studio-backend/"
```

Restart or rely on Vite HMR after copy.
