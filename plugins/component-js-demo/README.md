# component-js-demo

Minimal JavaScript WebAssembly Component guest for Phase E.

This demo uses:

- `@bytecodealliance/jco` 1.35.0
- `@bytecodealliance/componentize-js` 0.23.0
- the repository's shared `wit/plugin.wit`
- QuickJS synchronous componentization with WASI imports replaced by trap stubs

The QuickJS build intentionally does not call WASI. It validates the language-neutral plugin lifecycle and tool path without granting a sandboxed JS runtime a new ambient WASI authority surface. A second `build:preview2` target uses the default StarlingMonkey runtime and is supported for trusted Components through the host's Preview2 + WASI HTTP bridge.

## Build

```bash
bash plugins/component-js-demo/build-component.sh
```

Trusted Preview2 / default StarlingMonkey build:

```bash
cd plugins/component-js-demo
npm run build:preview2
cargo run -p wasm-plugin-host --example component_smoke -- \
  plugins/component-js-demo/dist/component-js-demo.preview2.component.wasm \
  js_component_echo
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

The default StarlingMonkey componentization path imports WASI Preview2 interfaces, including `wasi:io/*` and `wasi:http/*`. The host supplies `wasmtime-wasi::p2` plus `wasmtime-wasi-http` for both trust modes, but authority is still determined by `HostState` and `CapabilityGate`.

Trusted Components receive the trusted Preview2 context. Sandboxed Components can also instantiate the same StarlingMonkey artifact, but keep closed/sink stdio, no ambient env/args, raw sockets/IP lookup denied by default, and only explicit filesystem **read** grants become Preview2 preopens. Preview2 `wasi:http` outbound requests are checked by the same `network.allow` / method / sensitive-target gate as the custom host HTTP import. Mutation capabilities remain on the host-mediated WIT filesystem API because Preview2's single `MUTATE` bit would otherwise collapse `write/create/delete` into broader authority.
