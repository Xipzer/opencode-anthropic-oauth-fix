#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DIR="$CONFIG_DIR/plugins"
PACKAGE_JSON="$CONFIG_DIR/package.json"
OPENCODE_JSON="$CONFIG_DIR/opencode.json"
PLUGIN_FILE="$PLUGIN_DIR/opencode-anthropic-auth.ts"
SOURCE_PLUGIN="$SCRIPT_DIR/src/opencode-anthropic-auth.ts"

mkdir -p "$PLUGIN_DIR"

python3 - "$PACKAGE_JSON" <<'PY'
import json
import os
import sys

package_json = sys.argv[1]

data = {}
if os.path.exists(package_json):
    with open(package_json, "r", encoding="utf-8") as f:
        raw = f.read().strip()
        if raw:
            data = json.loads(raw)

if not isinstance(data, dict):
    raise SystemExit(f"{package_json} must contain a JSON object")

deps = data.get("dependencies")
if deps is None:
    deps = {}
if not isinstance(deps, dict):
    raise SystemExit(f"{package_json}: dependencies must be an object")

deps["@opencode-ai/plugin"] = deps.get("@opencode-ai/plugin", "1.4.0")
deps["opencode-anthropic-auth"] = "0.0.13"
deps["proper-lockfile"] = "4.1.2"
data["dependencies"] = deps

with open(package_json, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, sort_keys=True)
    f.write("\n")
PY

python3 - "$OPENCODE_JSON" <<'PY'
import json
import os
import sys

config_path = sys.argv[1]
plugin_name = "opencode-anthropic-auth@0.0.13"

data = {}
if os.path.exists(config_path):
    with open(config_path, "r", encoding="utf-8") as f:
        raw = f.read().strip()
        if raw:
            data = json.loads(raw)

if not isinstance(data, dict):
    raise SystemExit(f"{config_path} must contain a JSON object")

plugins = data.get("plugin")
if plugins is None:
    plugins = []
if not isinstance(plugins, list):
    raise SystemExit(f"{config_path}: plugin must be an array when present")

if plugin_name not in plugins:
    plugins.append(plugin_name)

data.setdefault("$schema", "https://opencode.ai/config.json")
data["plugin"] = plugins

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

cp "$SOURCE_PLUGIN" "$PLUGIN_FILE"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required but was not found in PATH" >&2
  exit 1
fi

(
  cd "$CONFIG_DIR"
  bun install
)

echo
echo "Anthropic OAuth fix installed."
echo "Config dir: $CONFIG_DIR"
echo "Plugin file: $PLUGIN_FILE"
echo
echo "Next steps:"
echo "1. Restart OpenCode/Kimaki or start a fresh session."
echo "2. Run: opencode providers login --provider anthropic"
echo
echo "Available Anthropic methods should include:"
echo "  - Add Claude Pro/Max Account"
echo "  - Add Claude Pro/Max Account (Manual / Remote)"
echo "  - Use saved account: <label>"
echo "  - Create an API Key"
echo "  - Create an API Key (Manual / Remote)"
