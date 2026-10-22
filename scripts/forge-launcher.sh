#!/usr/bin/env bash
# Deprecated compatibility wrapper for forge-launcher; retained for one release.
# The canonical implementation is the Node npm package at scripts/forge-launcher/.
# Keep existing invocations working during the package migration.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/forge-launcher" && pwd)"

if [[ -f "$PKG_DIR/dist/cli.js" ]]; then
  exec node "$PKG_DIR/dist/cli.js" "$@"
fi
if command -v tsx &>/dev/null; then
  exec tsx "$PKG_DIR/scripts/cli.ts" "$@"
fi
if [[ -x "$PKG_DIR/node_modules/.bin/tsx" ]]; then
  exec "$PKG_DIR/node_modules/.bin/tsx" "$PKG_DIR/scripts/cli.ts" "$@"
fi
echo "forge-launcher: package not built. Run in scripts/forge-launcher/: npm install && npm run build" >&2
exit 1
