#!/usr/bin/env bash
# Run all regression checks on the local development machine only.
# No GitHub Actions workflows, remote runners, or CI dispatch are invoked.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$ROOT/plugins/openhanako-shell"
# Rustup often installs cargo outside the Runner's inherited PATH.
if ! command -v cargo >/dev/null 2>&1 && [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
STUDIO_ROOT="${STUDIO_ROOT:-$(cd "$ROOT/.." && pwd)/dsh-wasm-studio}"

echo '[local] OpenHanako JavaScript regression'
npm --prefix "$PLUGIN" test
echo '[local] Automation React component regression'
(cd "$PLUGIN/ui" && ./node_modules/.bin/vitest run \
  desktop/src/react/__tests__/components/AutomationPanel.test.tsx \
  desktop/src/react/components/chat/__tests__/TrajectoryView.test.tsx \
  desktop/src/react/components/app/__tests__/ChatPage.trajectory.test.tsx)
echo '[local] OpenHanako TypeScript'
npm --prefix "$PLUGIN/ui" run typecheck
echo '[local] Renderer production bundle'
npm --prefix "$PLUGIN/ui" run build:renderer

if [[ -f "$STUDIO_ROOT/src-tauri/Cargo.toml" ]]; then
  echo '[local] Studio host compile and unit tests'
  cargo check --manifest-path "$STUDIO_ROOT/src-tauri/Cargo.toml" --all-targets
  cargo test --manifest-path "$STUDIO_ROOT/src-tauri/Cargo.toml" --lib
  echo '[local] Studio integration: sessions, plugin tools, approvals and restart'
  cargo test --manifest-path "$STUDIO_ROOT/src-tauri/Cargo.toml" --test session_branch --test studio -- --test-threads=2
  echo '[local] Vendored dsh-rs unit tests'
  cargo test --manifest-path "$STUDIO_ROOT/vendor/dsh-rs/Cargo.toml" --lib
else
  echo "[local] Studio repo not found at $STUDIO_ROOT; Studio checks skipped" >&2
fi

echo '[local] All available local checks completed (no GitHub CI)'
