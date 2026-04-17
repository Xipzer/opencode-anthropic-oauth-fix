#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DIR="$CONFIG_DIR/plugins"
PLUGIN_FILE="$PLUGIN_DIR/opencode-anthropic-auth.ts"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$PLUGIN_DIR"

if [ -f "$PLUGIN_FILE" ]; then
  mv "$PLUGIN_FILE" "$PLUGIN_FILE.bak.$TS"
fi

rm -f \
  "$CONFIG_DIR/anthropic-accounts.json" \
  "$CONFIG_DIR/anthropic-pending-oauth.json" \
  "$CONFIG_DIR/anthropic-auth-debug.log"

echo
echo "Local Anthropic multi-account extension removed."
echo "Config dir: $CONFIG_DIR"
echo
echo "Removed:"
echo "  - local Anthropic wrapper plugin"
echo "  - saved Anthropic account metadata"
echo "  - legacy Anthropic sidecar files from earlier versions"
echo
echo "Kept intact:"
echo "  - kimaki package dependency in package.json"
echo "  - canonical auth.json"
echo
echo "Next steps:"
echo "1. Restart OpenCode/Kimaki or start a fresh session."
echo "2. In Kimaki, Anthropic will fall back to Kimaki's built-in plugin behavior."
