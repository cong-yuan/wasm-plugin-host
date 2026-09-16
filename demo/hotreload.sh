#!/bin/bash
# Prove: a RUNNING host picks up a rebuilt wasm and swaps code, atomically.
set -e
cd "$(dirname "$0")/.."

# Point the config at a *staging* copy we can overwrite without racing cargo.
mkdir -p demo/stage
cp target/wasm32-wasip1/release/hello_rust.wasm demo/stage/greet.wasm

cat > demo/live.json <<'EOF'
{
  "watch": { "enabled": true, "interval_ms": 200 },
  "plugins": {
    "greet": { "path": "stage/greet.wasm", "enabled": true }
  }
}
EOF

# Feed commands with delays so the watcher has time to notice mtime changes.
(
  echo 'reconcile'
  sleep 1
  echo 'call greet {"who":"world"}'
  sleep 0.5
  # --- swap in the v2 build while the host is live ---
  cp target/wasm32-wasip1/release/hello_rust_v2.wasm demo/stage/greet.wasm
  sleep 1.2          # let the watcher fire
  echo 'call greet {"who":"world"}'
  sleep 0.3
  echo 'plugins'
  echo 'quit'
) | ./target/release/plugin-host --config demo/live.json
