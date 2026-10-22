#!/usr/bin/env bash
# Deprecated compatibility wrapper for forge-engine-run; retained for one release.
# The canonical implementation is the Node npm package at scripts/forge-launcher/.
# Keep existing invocations working during the package migration.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/forge-launcher" && pwd)"

exec_forge() {
  if [[ -f "$PKG_DIR/dist/cli.js" ]]; then
    exec node "$PKG_DIR/dist/cli.js" "$@"
  fi
  if command -v tsx &>/dev/null; then
    exec tsx "$PKG_DIR/scripts/cli.ts" "$@"
  fi
  if [[ -x "$PKG_DIR/node_modules/.bin/tsx" ]]; then
    exec "$PKG_DIR/node_modules/.bin/tsx" "$PKG_DIR/scripts/cli.ts" "$@"
  fi
  echo "forge-engine-run: package not built. Run in scripts/forge-launcher/: npm install && npm run build" >&2
  exit 1
}

exec_forge engine-run "$@"
