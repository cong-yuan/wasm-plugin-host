#!/usr/bin/env bash
# Run the owned Hana UI vite server (default http://127.0.0.1:5173).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../ui" && pwd)"
cd "$ROOT"
if [[ ! -d node_modules ]]; then
  echo "Installing ui deps…"
  npm install
fi
exec npm run dev:web
