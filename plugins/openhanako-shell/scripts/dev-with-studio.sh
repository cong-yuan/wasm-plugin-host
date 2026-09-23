#!/usr/bin/env bash
# Start Hana UI (5173) + Studio together.
# Usage:
#   plugins/openhanako-shell/scripts/dev-with-studio.sh
# Env:
#   STUDIO_DIR   override Studio checkout (default: ../../dsh-wasm-studio next to wasm-plugin-host, or ~/dsh-wasm-studio)
#   SKIP_STUDIO=1  only ensure UI is up
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI_ROOT="$PLUGIN_ROOT/ui"
HOST_ROOT="$(cd "$PLUGIN_ROOT/../.." && pwd)"

if [[ -n "${STUDIO_DIR:-}" ]]; then
  STUDIO="$STUDIO_DIR"
elif [[ -d "$HOST_ROOT/../dsh-wasm-studio" ]]; then
  STUDIO="$(cd "$HOST_ROOT/../dsh-wasm-studio" && pwd)"
elif [[ -d "$HOME/dsh-wasm-studio" ]]; then
  STUDIO="$HOME/dsh-wasm-studio"
else
  echo "找不到 dsh-wasm-studio。请设置 STUDIO_DIR=/path/to/dsh-wasm-studio" >&2
  exit 1
fi

UI_URL="${OPENHANAKO_UI_URL:-http://127.0.0.1:5173/index.html}"
UI_HOST_PORT="127.0.0.1:5173"

ui_up() {
  curl -fsS -o /dev/null --connect-timeout 1 --max-time 2 "http://${UI_HOST_PORT}/index.html" 2>/dev/null
}

start_ui() {
  if ui_up; then
    echo "[dev-with-studio] Hana UI 已在 ${UI_HOST_PORT} 运行"
    return 0
  fi
  if [[ ! -d "$UI_ROOT/node_modules" ]]; then
    echo "[dev-with-studio] 首次安装 UI 依赖…"
    (cd "$UI_ROOT" && npm install)
  fi
  echo "[dev-with-studio] 启动 Hana UI (npm run dev:web)…"
  # Keep UI alive after this script exits / Studio closes.
  nohup npm --prefix "$UI_ROOT" run dev:web > /tmp/openhanako-dev-web.log 2>&1 &
  echo $! > /tmp/openhanako-dev-web.pid
  disown || true

  for i in $(seq 1 60); do
    if ui_up; then
      echo "[dev-with-studio] Hana UI ready → $UI_URL"
      return 0
    fi
    sleep 0.5
  done
  echo "[dev-with-studio] UI 启动超时，见 /tmp/openhanako-dev-web.log" >&2
  exit 1
}

start_ui

if [[ "${SKIP_STUDIO:-0}" == "1" ]]; then
  echo "[dev-with-studio] SKIP_STUDIO=1，只启动了 UI"
  exit 0
fi

echo "[dev-with-studio] 启动 Studio → $STUDIO"
cd "$STUDIO"
# Prefer tauri dev (desktop app). Falls back to vite-only web if tauri missing.
if npm run | grep -q 'tauri'; then
  exec npm run tauri -- dev
else
  exec npm run dev
fi
