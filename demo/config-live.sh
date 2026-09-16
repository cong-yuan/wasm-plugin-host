#!/bin/bash
# Prove: changing ONE plugin's config updates ONLY that plugin.
set -e
cd "$(dirname "$0")/.."
cp target/wasm32-wasip1/release/hello_rust.wasm demo/stage/greet.wasm

cat > demo/livecfg.json <<'EOF'
{
  "watch": { "enabled": true, "interval_ms": 200 },
  "plugins": {
    "greet":  { "path": "stage/greet.wasm", "enabled": true, "config": { "greeting": "Hello" } },
    "greet2": { "path": "stage/greet.wasm", "enabled": true, "config": { "greeting": "Hi" }, "watch": false }
  }
}
EOF

# greet2 shares greet's tool names -> would collide. Give greet2 its own build.
# Instead: use the SAME wasm but rename tools is not possible; so we use one slot
# and demonstrate per-slot diffing with two DIFFERENT plugins.
cat > demo/livecfg.json <<'EOF'
{
  "watch": { "enabled": true, "interval_ms": 200 },
  "plugins": {
    "greet":  { "path": "stage/greet.wasm", "enabled": true, "config": { "greeting": "Hello" }, "watch": false },
    "goplug": { "path": "../plugins/hello-go/hello_go.wasm", "enabled": true, "config": { "greeting": "Bonjour" }, "watch": false }
  }
}
EOF

(
  echo 'reconcile'
  sleep 0.6
  echo 'call greet {"who":"X"}'
  sleep 0.3
  # --- edit ONLY greet's config while running ---
  python3 - <<'PY'
import json
p='demo/livecfg.json'
d=json.load(open(p))
d['plugins']['greet']['config']['greeting']='HELLO (live!)'
json.dump(d, open(p,'w'), indent=2)
PY
  sleep 0.9          # watcher polls config
  echo 'call greet {"who":"X"}'     # should show new greeting
  echo 'call echo_num {"n":5}'
  echo 'status'
  echo 'quit'
) | ./target/release/plugin-host --config demo/livecfg.json 2>&1
