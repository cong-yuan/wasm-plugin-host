# component-rust-demo-v2

Minimal Rust guest for the parallel WIT 0.2 transport contract.

It differs from the 0.1 demo in one wire-level feature: `tool-decl.requires`.
The guest declares:

```text
component_base_v2
component_echo_v2 -> requires component_base_v2
```

The semantic plugin ABI is still `abi-version() == 1`; `0.2.0` is the WIT
transport package version, not a second Registry/plugin lifecycle ABI.

## Build

```bash
bash plugins/component-rust-demo-v2/build-component.sh
```

## Smoke

```bash
cargo run -p wasm-plugin-host --example component_smoke -- \
  plugins/component-rust-demo-v2/target/component-rust-demo-v2.component.wasm \
  component_echo_v2
```

`plugin-check --json` should report
`component_echo_v2: ["component_base_v2"]` in `tool_dependencies`.
