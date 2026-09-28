# component-rust-demo

Minimal successful WebAssembly Component guest for Phase E.

It uses the same `wit/plugin.wit` contract as the host:

- `wit-bindgen` generates the guest canonical ABI from the WIT world.
- The guest is compiled to `wasm32-unknown-unknown`.
- The small `componentize/` helper uses `wit-component::ComponentEncoder`
  to turn the metadata-bearing core module into a real Component.
- The host loads it through the normal `Registry` / `PluginBackend::Component`
  path.

## Build

```bash
bash plugins/component-rust-demo/build-component.sh
```

The output is:

```text
plugins/component-rust-demo/target/component-rust-demo.component.wasm
```

No generated `target/` files are committed.

## Smoke test

```bash
cargo run -p wasm-plugin-host --example component_smoke -- \
  plugins/component-rust-demo/target/component-rust-demo.component.wasm
```

Expected behavior:

- slot loads as `component-rust-demo`
- tool `component_echo` is registered from typed `describe()`
- invoking it returns the input JSON through typed `InvokeResult::Success`
- unload calls typed `shutdown()`

This demo intentionally requests no capabilities. Network/filesystem/service
imports are tested separately in the host's Component backend tests.

## Why Rust first

The host contract is language-neutral. This fixture proves the Component path
without requiring a globally installed Component CLI. A future JS/jco or
Python/componentize-py guest should produce the same WIT world and can use the
same `component_smoke` runner unchanged.
