# component-js-demo

Minimal JavaScript WebAssembly Component guest for Phase E.

This demo uses:

- `@bytecodealliance/jco` 1.35.0
- `@bytecodealliance/componentize-js` 0.23.0
- the repository's shared `wit/plugin.wit`
- QuickJS synchronous componentization with WASI imports replaced by trap stubs

The last point is intentional: this demo does not call WASI. It validates the
language-neutral plugin lifecycle and tool path without granting a JS runtime a
new ambient WASI authority surface.

## Build

```bash
bash plugins/component-js-demo/build-component.sh
```

Equivalent componentization command:

```bash
jco componentize component.js \
  --wit ../../wit \
  -n plugin \
  -o dist/component-js-demo.component.wasm \
  --backend qjs \
  --backend-qjs-disable-async \
  --backend-qjs-stub-wasi
```

## Smoke test

```bash
cargo run -p wasm-plugin-host --example component_smoke -- \
  plugins/component-js-demo/dist/component-js-demo.component.wasm \
  js_component_echo
```

Expected behavior:

- plugin loads as `component-js-demo`
- `js_component_echo` is registered from typed `describe()`
- typed `invoke()` echoes the input JSON
- typed `shutdown()` runs during unload

## WASI boundary

The default StarlingMonkey componentization path imports WASI Preview2
interfaces (the first observed import was `wasi:io/poll@0.2.12`). The current
host Component linker intentionally does not provide a general Preview2 WASI
context yet, so a default JS runtime component is rejected rather than receiving
ambient authority.

Production JS components that need clocks, filesystem, HTTP, random, stdio, or
other WASI facilities should wait for a dedicated Component-WASI bridge that
maps those interfaces back into the same capability policy/audit model. Do not
work around that boundary by granting unrestricted Preview2 WASI.
