# component-python-demo

Minimal Python WebAssembly Component producer for WIT 0.3.

Requires Python 3.11+; CI pins Python 3.12 because current componentize-py generated bindings use `typing.Self`.

The guest uses `componentize-py 0.25.1` and exports the same lifecycle world as
the Rust/JS fixtures. It requests no capabilities and uses `--stub-wasi`, so
the smoke test focuses on language-neutral lifecycle + tool transport.

## Build

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/componentize-py \
  -d ../../wit-v0.3 \
  -w plugin \
  componentize \
  --stub-wasi \
  -p . \
  app \
  -o dist/component-python-demo.component.wasm
```

## Validate and smoke

```bash
cargo run -p wasm-plugin-host -- plugin-check \
  plugins/component-python-demo/dist/component-python-demo.component.wasm --json

cargo run -p wasm-plugin-host --example component_smoke -- \
  plugins/component-python-demo/dist/component-python-demo.component.wasm \
  python_component_echo \
  sandboxed
```

The local macOS runner previously terminated componentize-py's runtime packaging
phase with SIGKILL even for minimal guests, while bindings generation worked.
The canonical producer validation therefore runs on Ubuntu 24.04 CI.
