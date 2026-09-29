#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OPENHANAKO="$ROOT/plugins/openhanako-shell"
UI="$OPENHANAKO/ui"
DEEP=0

if [[ "${1:-}" == "--deep" ]]; then
  DEEP=1
fi

before_kb() {
  du -sk "$@" 2>/dev/null | awk '{sum += $1} END {print sum + 0}'
}

remove_path() {
  local path="$1"
  if [[ -e "$path" || -L "$path" ]]; then
    rm -rf "$path"
    printf 'removed %s\n' "$path"
  fi
}

# Disposable OpenHanako build output. Never remove ui/build: it contains tracked
# installer / manifest source files.
for path in   "$UI/desktop/dist-renderer"   "$UI/desktop/dist-splash"   "$UI/desktop/dist-theme"   "$UI/desktop/dist-preload"   "$UI/desktop/dist-main"   "$UI/dist"   "$UI/dist-server"   "$UI/dist-server-artifact"   "$UI/dist-computer-use"   "$UI/dist-sandbox"   "$UI/coverage"   "$UI/.vite"   "$UI/.cache"
do
  remove_path "$path"
done

# npx installs are disposable execution sandboxes. Keep npm's _cacache because
# it avoids re-downloading packages, and keep node_modules in the default mode.
remove_path "$HOME/.npm/_npx"
remove_path "$HOME/.npm/_logs"

# Small language/tool scratch inside this repository.
find "$ROOT" \( -path "$ROOT/.git" -o -name node_modules -o -name target \) -prune -o \
  -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
find "$ROOT" \( -path "$ROOT/.git" -o -name node_modules -o -name target \) -prune -o \
  -type f \( -name '*.pyc' -o -name '*.pyo' -o -name '*.tsbuildinfo' \) -delete 2>/dev/null || true

if [[ "$DEEP" -eq 1 ]]; then
  # Deep mode trades future build speed for disk space. Package download caches
  # remain intact so reinstall/rebuild does not need to fetch everything again.
  remove_path "$UI/node_modules"
  remove_path "$ROOT/target"
  find "$ROOT/plugins" -type d -path '*/componentize/target' -prune -exec rm -rf {} + 2>/dev/null || true
fi

printf 'cleanup complete (%s mode)\n' "$([[ "$DEEP" -eq 1 ]] && echo deep || echo light)"
