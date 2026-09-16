#!/bin/bash
# Prove: a BROKEN rebuild leaves the running plugin untouched.
set -e
cd "$(dirname "$0")/.."

mkdir -p demo/stage
cp target/wasm32-wasip1/release/hello_rust.wasm demo/stage/greet.wasm

cat > demo/broken.json <<'EOF'
{
  "watch": { "enabled": true, "interval_ms": 200 },
  "plugins": { "greet": { "path": "stage/greet.wasm", "enabled": true } }
}
EOF

# Make a deliberately broken wasm (not valid wasm at all).
echo "this is not wasm" > demo/stage/broken.wasm

(
  echo 'reconcile'
  sleep 0.8
  echo 'call greet {"who":"world"}'
  sleep 0.3
  # --- overwrite the live wasm with garbage ---
  cp demo/stage/broken.wasm demo/stage/greet.wasm
  sleep 1.2
  echo 'call greet {"who":"world"}'   # must STILL work (old plugin kept)
  sleep 0.3
  # --- now put a GOOD v2 back; watcher should recover ---
  cp target/wasm32-wasip1/release/hello_rust_v2.wasm demo/stage/greet.wasm
  sleep 1.2
  echo 'call greet {"who":"world"}'
  echo 'quit'
) | ./target/release/plugin-host --config demo/broken.json 2>&1
