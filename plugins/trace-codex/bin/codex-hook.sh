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

url="https://github.com/$REPO/releases/download/trace-codex-v$version/codex-hook-$suffix"
tmp="$BIN.download.$$"

mkdir -p "$ROOT/bin" 2>/dev/null || {
  log "could not create $ROOT/bin; tracing disabled this session"
  exit 0
}

# Download with curl, falling back to wget. -f makes curl fail on HTTP errors.
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

if [ "$ok" -ne 0 ] || [ ! -s "$tmp" ]; then
  rm -f "$tmp" 2>/dev/null
  log "failed to download $url; tracing disabled this session"
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
