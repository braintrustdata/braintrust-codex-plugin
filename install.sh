#!/bin/bash
###
# Local dev install for the Braintrust Codex plugins.
#
# Codex has no `--plugin-dir` flag. Plugins are loaded from a marketplace and
# COPIED into a versioned cache under ~/.codex/plugins/cache/. Codex validates
# that the cached plugin is a real directory under the cache root, so a symlink
# back to the repo does NOT work (Codex reports it as "not installed").
#
# This script therefore does a normal install (a copy) and re-syncs that copy
# on every run. Re-run it whenever you edit plugin files so Codex picks up the
# changes.
#
# What it does:
#   1. registers this repo as a local marketplace,
#   2. installs the plugin(s) so Codex copies them into the cache and writes the
#      correct config entries.
#
# Usage:
#   ./install.sh                            # install all plugins in this repo
#   ./install.sh trace-codex                # install just one plugin (by folder)
#
# Use ./uninstall.sh to remove.
###

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKETPLACE="braintrust-codex-plugins"

# Plugin folders to install. Default: every folder under plugins/.
if [ "$#" -gt 0 ]; then
  PLUGINS=("$@")
else
  PLUGINS=()
  for d in "$REPO_ROOT"/plugins/*/; do
    PLUGINS+=("$(basename "$d")")
  done
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Error: 'codex' CLI not found. Install Codex CLI first." >&2
  exit 1
fi

echo "Installing Braintrust Codex plugins from: $REPO_ROOT"
echo ""

# 1. (Re)register the local marketplace so the snapshot reflects the current
#    marketplace.json. Remove first so a fresh snapshot is taken.
echo "Registering local marketplace '$MARKETPLACE'..."
codex plugin marketplace remove "$MARKETPLACE" >/dev/null 2>&1 || true
codex plugin marketplace add "$REPO_ROOT" >/dev/null
echo "  done."
echo ""

read_json_field() {
  # read_json_field <file> <field> -> first string value for that field
  grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$1" | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

# Build a plugin's compiled assets if it has a build (build-on-install).
build_plugin() {
  plugin_src="$1"
  if [ ! -f "$plugin_src/package.json" ]; then
    return 0
  fi
  if ! grep -q '"build"' "$plugin_src/package.json"; then
    return 0
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "Error: '$folder' needs pnpm to build, but 'pnpm' was not found." >&2
    echo "       Install pnpm from https://pnpm.io/installation and re-run ./install.sh" >&2
    exit 1
  fi
  echo "  building (pnpm)..."
  ( cd "$plugin_src" && pnpm install --reporter=silent && BUILD_HOST_ONLY=1 pnpm run build )
}

for folder in "${PLUGINS[@]}"; do
  plugin_src="$REPO_ROOT/plugins/$folder"
  manifest="$plugin_src/.codex-plugin/plugin.json"

  if [ ! -f "$manifest" ]; then
    echo "Skipping '$folder': no manifest at $manifest" >&2
    continue
  fi

  # The installable plugin name is the manifest `name` (Codex requires the
  # marketplace entry name to match it), which may differ from the folder name.
  name="$(read_json_field "$manifest" name)"
  version="$(read_json_field "$manifest" version)"
  if [ -z "$name" ] || [ -z "$version" ]; then
    echo "Skipping '$folder': could not read name/version from manifest" >&2
    continue
  fi

  echo "Installing '$name' (v$version) from plugins/$folder..."
  # Build compiled assets first so the marketplace copy includes them.
  build_plugin "$plugin_src"
  # Remove any prior install so the copy is re-synced from the current files.
  codex plugin remove "$name@$MARKETPLACE" >/dev/null 2>&1 || true
  codex plugin add "$name" --marketplace "$MARKETPLACE" >/dev/null
  echo "  installed."

done

echo ""
echo "Done. Next steps:"
echo "  1. Restart Codex (or start a new session) so it loads the plugins."
echo "  2. Plugin hooks are non-managed: run /hooks in the Codex CLI and trust them"
echo "     before they will fire."
echo ""
echo "After editing plugin files, re-run ./install.sh to re-sync the cached copy."
