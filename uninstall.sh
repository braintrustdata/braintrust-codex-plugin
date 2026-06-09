#!/bin/bash
###
# Remove the local dev install created by ./install.sh:
# uninstalls the plugins, removes the local marketplace, and clears the cache
# (including the dev symlinks).
###

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKETPLACE="braintrust-codex-plugins"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CACHE_DIR="$CODEX_HOME/plugins/cache/$MARKETPLACE"

if ! command -v codex >/dev/null 2>&1; then
  echo "Error: 'codex' CLI not found." >&2
  exit 1
fi

echo "Uninstalling Braintrust Codex plugins..."

for d in "$REPO_ROOT"/plugins/*/; do
  manifest="$d/.codex-plugin/plugin.json"
  [ -f "$manifest" ] || continue
  # Installable name is the manifest `name`, which may differ from the folder.
  name="$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$manifest" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  [ -n "$name" ] || continue
  codex plugin remove "$name@$MARKETPLACE" >/dev/null 2>&1 \
    && echo "  removed plugin '$name'" \
    || true
done

codex plugin marketplace remove "$MARKETPLACE" >/dev/null 2>&1 \
  && echo "  removed marketplace '$MARKETPLACE'" \
  || true

# Clear any leftover cache (including dev symlinks).
rm -rf "$CACHE_DIR" 2>/dev/null || true

echo "Done. Restart Codex to fully unload the plugins."
