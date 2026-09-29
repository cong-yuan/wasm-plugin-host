# component-rust-hook-demo

Rust WIT 0.4 guest validating typed hook decisions.

The plugin declares a `tools/pre-execute` waterfall hook and returns a typed
`hook-decision.veto` from the new `invoke-hook` lifecycle export.

```bash
bash plugins/component-rust-hook-demo/build-component.sh
cargo run -p wasm-plugin-host --example component_hook_smoke -- \
  plugins/component-rust-hook-demo/target/component-rust-hook-demo.component.wasm
```
