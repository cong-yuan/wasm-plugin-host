# component-rust-ui-demo

Rust WebAssembly Component guest for WIT 0.3.

It validates two 0.3 wire features together:

- typed `tool-decl.requires`;
- typed `ui-decl` instead of the legacy `ui-json` bridge.

Build:

```bash
bash plugins/component-rust-ui-demo/build-component.sh
```

Artifact:

```text
plugins/component-rust-ui-demo/target/component-rust-ui-demo.component.wasm
```

Inspect:

```bash
cargo run -p wasm-plugin-host -- plugin-check \
  plugins/component-rust-ui-demo/target/component-rust-ui-demo.component.wasm --json
```

Smoke:

```bash
cargo run -p wasm-plugin-host --example component_smoke -- \
  plugins/component-rust-ui-demo/target/component-rust-ui-demo.component.wasm \
  component_ui_echo
```
