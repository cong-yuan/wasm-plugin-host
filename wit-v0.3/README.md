# WIT 0.3

`wasm-plugin-host:plugin@0.3.0` is the next parallel Component contract after
0.1 and 0.2.

It keeps typed tool dependencies from 0.2 and replaces the legacy `ui-json`
bridge with a typed `ui: option<ui-decl>`.

Typed UI covers:

- provided/injected slots;
- frontend assets;
- windows and window-open/content modes;
- routes/navigation;
- UI adjustments.

The Host converts these records directly into the existing internal `UiDecl`
model. Registry/UI capability semantics do not change.

0.1 and 0.2 remain supported. Runtime dispatch detects the exported lifecycle
package version and instantiates the matching generated bindings/linker.

Validation:

```bash
cargo test -p wasm-plugin-host --test wit_contract
bash plugins/component-rust-ui-demo/build-component.sh
cargo run -p wasm-plugin-host -- plugin-check \
  plugins/component-rust-ui-demo/target/component-rust-ui-demo.component.wasm --json
cargo run -p wasm-plugin-host --example component_smoke -- \
  plugins/component-rust-ui-demo/target/component-rust-ui-demo.component.wasm \
  component_ui_echo
```
