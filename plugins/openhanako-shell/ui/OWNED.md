# Owned frontend

This tree is the Hana UI used by `openhanako-shell`.

- Origin: snapshot of [liliMozi/openhanako](https://github.com/liliMozi/openhanako) (Apache-2.0), plus Studio patches.
- Do **not** treat an external `openhanako` / `openhanako-ui` checkout as the source of truth.
- Edit files here; commit in `wasm-plugin-host`.
- `node_modules/` is local-only (`npm install` in this directory).

## Dev notes (Studio + UI)

- Source of truth: this `ui/` tree (not an external openhanako clone).
- One-shot: `bash plugins/openhanako-shell/scripts/dev-with-studio.sh` starts UI on `:5173` then Studio.
- UI only: `cd plugins/openhanako-shell/ui && npm run dev:web`.
- Chat chrome: history scrollbar hidden; right rail shows faint user-question ticks when ≥2 turns; hover expands labels; composer has a project/mode/branch strip underneath.
