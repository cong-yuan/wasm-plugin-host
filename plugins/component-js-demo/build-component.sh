#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

if [ -f package-lock.json ]; then
  npm ci --ignore-scripts
else
  npm install --ignore-scripts
fi
npm run build

echo "component: $HERE/dist/component-js-demo.component.wasm"
echo "smoke:"
echo "  cargo run -p wasm-plugin-host --example component_smoke -- $HERE/dist/component-js-demo.component.wasm js_component_echo"
