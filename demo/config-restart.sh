#!/bin/bash
# Prove: restart_on_config=true restarts ONLY that plugin when its config changes.
set -e
cd "$(dirname "$0")/.."
cp target/wasm32-wasip1/release/hello_rust.wasm demo/stage/greet.wasm

cat > demo/restart.json <<'EOF'
{
  "watch": { "enabled": true, "interval_ms": 200 },
  "plugins": {
    "greet":  { "path": "stage/greet.wasm", "enabled": true,
                "config": { "greeting": "Hello" }, "restart_on_config": true, "watch": false },
    "goplug": { "path": "../plugins/hello-go/hello_go.wasm", "enabled": true,
                "config": { "greeting": "Bonjour" }, "watch": false }
  }
}
EOF

(
  echo 'reconcile'
  sleep 0.5
  python3 - <<'PY'
import json
p='demo/restart.json'; d=json.load(open(p))
d['plugins']['greet']['config']['greeting']='RESTARTED!'
json.dump(d, open(p,'w'), indent=2)
PY
  sleep 0.9
  echo 'call greet {"who":"X"}'
  echo 'quit'
) | ./target/release/plugin-host --config demo/restart.json 2>&1 | grep -E "loaded|config|template|restart|content\"" 
