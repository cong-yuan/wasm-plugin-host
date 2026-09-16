#!/usr/bin/env bash
# Demonstrate the on-disk precompiled-module cache (P2).
#
# First run compiles the Go plugin and writes a .cwasm; the second run
# deserializes it instead of compiling. Watch the `cache` counters.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=target/debug/plugin-host
CACHE="$(pwd)/demo/.cwasm-cache"
GO="$(pwd)/plugins/hello-go/hello_go.wasm"

if [[ ! -x "$BIN" ]]; then
  echo "building plugin-host..."
  cargo build -p wasm-plugin-host >/dev/null
fi

rm -rf "$CACHE"
cat > /tmp/wph-cache-demo.json <<JSON
{
  "cache": { "dir": "$CACHE", "enabled": true },
  "watch": { "enabled": false },
  "plugins": { "go": { "path": "$GO", "enabled": true } }
}
JSON

echo "── run 1: cold (compiles + writes .cwasm) ─────────────"
printf 'reconcile\ncache\nquit\n' | "$BIN" --config /tmp/wph-cache-demo.json

echo
echo "── artifacts on disk ──────────────────────────────────"
ls -la "$CACHE" | grep cwasm || true

echo
echo "── run 2: warm (deserializes, no compile) ─────────────"
printf 'reconcile\ncache\nquit\n' | "$BIN" --config /tmp/wph-cache-demo.json

rm -f /tmp/wph-cache-demo.json
echo
echo "done — compare the 'hits/misses' counters between the two runs."
