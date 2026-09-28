#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CARGO_BIN="${CARGO:-cargo}"
CORE="$HERE/target/wasm32-unknown-unknown/release/component_rust_demo.wasm"
OUT="${1:-$HERE/target/component-rust-demo.component.wasm}"

"$CARGO_BIN" build \
  --manifest-path "$HERE/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --release

mkdir -p "$(dirname "$OUT")"
"$CARGO_BIN" run \
  --manifest-path "$HERE/componentize/Cargo.toml" \
  --release \
  -- "$CORE" "$OUT"

echo "component: $OUT"
echo "smoke:"
echo "  $CARGO_BIN run -p wasm-plugin-host --example component_smoke -- $OUT"
