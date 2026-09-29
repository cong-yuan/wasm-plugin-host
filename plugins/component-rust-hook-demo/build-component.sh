#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CARGO_BIN="${CARGO:-cargo}"
CORE="$HERE/target/wasm32-unknown-unknown/release/component_rust_hook_demo.wasm"
OUT="${1:-$HERE/target/component-rust-hook-demo.component.wasm}"
"$CARGO_BIN" build --manifest-path "$HERE/Cargo.toml" --target wasm32-unknown-unknown --release
"$CARGO_BIN" run --manifest-path "$HERE/componentize/Cargo.toml" --release -- "$CORE" "$OUT"
echo "component: $OUT"
