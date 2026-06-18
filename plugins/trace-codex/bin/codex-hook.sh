#!/bin/sh
# Launcher for the trace-codex hook binary.
#
# hooks.json invokes this script (a fixed, platform-agnostic command). The real
# binary is platform-specific and far too large to commit, so it is downloaded
# on demand from the plugin's GitHub release and cached next to this script at
# $PLUGIN_ROOT/bin/codex-hook.
#
# Because Codex wipes the versioned plugin cache ($PLUGIN_ROOT) on every
# install/upgrade, a cached binary there is automatically invalidated on
# upgrade: the next hook finds it missing and re-downloads the matching version.
# This means the hot path is just "is the binary here? exec it" with no version
# parsing, and upgrades self-heal with no manual step.
#
# Hard rule: never fail the Codex turn. Any error here logs to stderr and exits
# 0 (Codex treats a 0 exit with no stdout as success).

set -u

REPO="braintrustdata/braintrust-codex-plugin"

# PLUGIN_ROOT is set by Codex to the installed plugin directory. Fall back to
# this script's own directory's parent so the launcher is runnable standalone.
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
ROOT="${PLUGIN_ROOT:-$(dirname "$SCRIPT_DIR")}"
BIN="$ROOT/bin/codex-hook"

# Fast path: the binary is already cached for this plugin version. Run it.
if [ -x "$BIN" ]; then
  exec "$BIN" "$@"
fi

# --- Slow path: download the matching binary, then exec it. ---

log() { printf 'trace-codex launcher: %s\n' "$1" >&2; }

# Map uname output to our release asset suffix (<os>-<arch>).
os=$(uname -s 2>/dev/null || echo unknown)
arch=$(uname -m 2>/dev/null || echo unknown)
case "$os" in
  Darwin) os_name=darwin ;;
  Linux) os_name=linux ;;
  *) log "unsupported OS '$os'; tracing disabled this session"; exit 0 ;;
esac
case "$arch" in
  arm64 | aarch64) arch_name=arm64 ;;
  x86_64 | amd64) arch_name=x64 ;;
  *) log "unsupported arch '$arch'; tracing disabled this session"; exit 0 ;;
esac
suffix="$os_name-$arch_name"

# Read the plugin version (single source of truth) from the manifest. Only on
# this slow path, so no dependency (jq) and no parsing on the hot path.
manifest="$ROOT/.codex-plugin/plugin.json"
version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" 2>/dev/null | head -1)
if [ -z "$version" ]; then
  log "could not read plugin version from $manifest; tracing disabled this session"
  exit 0
fi

tag="trace-codex-v$version"
asset="codex-hook-$suffix"
url="https://github.com/$REPO/releases/download/$tag/$asset"
tmp="$BIN.download.$$"

mkdir -p "$ROOT/bin" 2>/dev/null || {
  log "could not create $ROOT/bin; tracing disabled this session"
  exit 0
}

# The release repo may be private, so the plain browser download URL 404s for
# unauthenticated callers. Try authenticated paths first (gh CLI, then a token
# from the environment via the GitHub API), then fall back to an unauthenticated
# download for the public-repo case. The first method that produces a non-empty
# file wins. Every method is best-effort and never fails the turn.
ok=1

# 1) gh CLI: uses the same credentials Codex used to install the plugin, and
#    transparently handles private repos. `gh release download` writes the asset
#    to the path given by -O.
if [ "$ok" -ne 0 ] && command -v gh >/dev/null 2>&1; then
  if gh release download "$tag" \
      --repo "$REPO" \
      --pattern "$asset" \
      --output "$tmp" \
      --clobber >/dev/null 2>&1 && [ -s "$tmp" ]; then
    ok=0
  else
    rm -f "$tmp" 2>/dev/null
  fi
fi

# 2) Token from the environment + GitHub API. The API asset endpoint with
#    Accept: application/octet-stream returns the binary (or a redirect curl
#    follows) for private repos when the token is authorized.
token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ "$ok" -ne 0 ] && [ -n "$token" ] && command -v curl >/dev/null 2>&1; then
  api="https://api.github.com/repos/$REPO/releases/tags/$tag"
  # Resolve the asset id from the release JSON, then download it by id via the
  # API octet-stream endpoint. The asset's "id" precedes its "name" in the JSON,
  # so split on commas and track the most recent "id" seen, emitting it when the
  # matching "name" line appears. Avoids a jq dependency on this path.
  asset_id=$(curl -fsSL \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.github+json" \
    "$api" 2>/dev/null \
    | tr ',' '\n' \
    | awk -v a="\"$asset\"" '
        /"id"[[:space:]]*:/ { match($0, /[0-9]+/); id = substr($0, RSTART, RLENGTH) }
        index($0, "\"name\"") && index($0, a) { print id; exit }
      ')
  if [ -n "$asset_id" ]; then
    curl -fsSL \
      -H "Authorization: Bearer $token" \
      -H "Accept: application/octet-stream" \
      "https://api.github.com/repos/$REPO/releases/assets/$asset_id" \
      -o "$tmp" 2>/dev/null
    if [ $? -eq 0 ] && [ -s "$tmp" ]; then
      ok=0
    else
      rm -f "$tmp" 2>/dev/null
    fi
  fi
fi

# 3) Unauthenticated download (works when the repo/releases are public).
if [ "$ok" -ne 0 ]; then
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$tmp" 2>/dev/null
    ok=$?
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$tmp" 2>/dev/null
    ok=$?
  else
    log "neither curl nor wget found; cannot download binary; tracing disabled this session"
    exit 0
  fi
fi

if [ "$ok" -ne 0 ] || [ ! -s "$tmp" ]; then
  rm -f "$tmp" 2>/dev/null
  log "failed to download $asset for $tag; tracing disabled this session"
  exit 0
fi

chmod +x "$tmp" 2>/dev/null
# Atomic rename into place so a concurrent hook never sees a half-written file.
mv -f "$tmp" "$BIN" 2>/dev/null || {
  rm -f "$tmp" 2>/dev/null
  log "could not install binary at $BIN; tracing disabled this session"
  exit 0
}

log "downloaded codex-hook $version ($suffix)"
exec "$BIN" "$@"
