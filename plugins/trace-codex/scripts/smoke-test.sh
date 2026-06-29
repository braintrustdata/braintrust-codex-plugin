#!/bin/sh
# End-to-end smoke test: run a real Codex session with the trace plugin enabled,
# pointed at a local mock Braintrust collector, and assert at least one trace row
# was reported.
#
# Usage:
#   scripts/smoke-test.sh [VERSION]
#
# VERSION (optional; or the SMOKE_RELEASE_VERSION env var) pins the release whose
# codex-hook binary the plugin launcher downloads, e.g. "0.0.1" or "v0.0.1". When
# unset, the launcher uses the installed plugin manifest version (the normal
# behavior). CI passes the version it just released; locally you can point this
# at any published release.
#
# Prerequisites (the caller is responsible for these):
#   - `codex` is on PATH and authenticated for `codex exec` (we pass
#     CODEX_API_KEY from OPENAI_API_KEY below).
#   - The trace-codex plugin is installed and enabled in Codex (the CI workflow
#     installs it from the published release; locally use ./install.sh).
#   - Bun is on PATH (used to run the mock collector).
#   - OPENAI_API_KEY is set.
#   - For a private release repo, GH_TOKEN or GITHUB_TOKEN (or an authenticated
#     `gh`) so the launcher can download the binary.
#
# Exit 0 on success (>=1 trace row received), non-zero otherwise.

set -eu

# Resolve the plugin dir from this script's location so it works from anywhere.
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
PLUGIN_DIR=$(dirname "$SCRIPT_DIR")

# Target release version: positional arg wins, then env, else empty (= manifest).
RELEASE_VERSION="${1:-${SMOKE_RELEASE_VERSION:-}}"

PORT="${MOCK_COLLECTOR_PORT:-53999}"
BASE_URL="http://127.0.0.1:$PORT"

log() { printf 'smoke: %s\n' "$1" >&2; }
fail() { printf 'smoke: FAIL: %s\n' "$1" >&2; exit 1; }

# Redact the API key from any text we print (defense-in-depth for the public
# repo: GitHub already masks the secret, but we never want to echo subprocess
# output that might contain it, transformed or otherwise). Reads stdin, writes
# scrubbed text to stderr. A no-op if the key is empty.
scrub() {
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    sed "s/${OPENAI_API_KEY}/[REDACTED]/g" 2>/dev/null || cat
  else
    cat
  fi
}

# --- Preconditions ---------------------------------------------------------

[ -n "${OPENAI_API_KEY:-}" ] || fail "OPENAI_API_KEY is not set"
command -v codex >/dev/null 2>&1 || fail "codex is not on PATH"
command -v bun >/dev/null 2>&1 || fail "bun is not on PATH"

# Belt-and-suspenders: explicitly mask the key in GitHub Actions logs. This
# covers any reformatted appearance beyond GitHub's automatic secret masking.
# Harmless (and silent) outside Actions.
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  printf '::add-mask::%s\n' "$OPENAI_API_KEY"
fi

WORK=$(mktemp -d)
SUMMARY="$WORK/summary.json"
COLLECTOR_LOG="$WORK/collector.log"
CODEX_LOG="$WORK/codex.log"

COLLECTOR_PID=""
cleanup() {
  # Ask the collector to flush its summary and stop; fall back to KILL.
  if [ -n "$COLLECTOR_PID" ] && kill -0 "$COLLECTOR_PID" 2>/dev/null; then
    kill -TERM "$COLLECTOR_PID" 2>/dev/null || true
    # Give it a moment to write the summary.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$COLLECTOR_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "$COLLECTOR_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# --- Start the mock collector ----------------------------------------------

log "starting mock collector on $BASE_URL"
MOCK_COLLECTOR_PORT="$PORT" MOCK_COLLECTOR_OUT="$SUMMARY" \
  bun run "$PLUGIN_DIR/scripts/mock-collector.ts" >"$COLLECTOR_LOG" 2>&1 &
COLLECTOR_PID=$!

# Wait for it to accept connections.
ready=0
for _ in $(seq 1 50); do
  if curl -fsS -o /dev/null --max-time 1 "$BASE_URL/version" 2>/dev/null; then
    ready=1
    break
  fi
  kill -0 "$COLLECTOR_PID" 2>/dev/null || break
  sleep 0.2
done
if [ "$ready" != "1" ]; then
  scrub <"$COLLECTOR_LOG" >&2 || true
  fail "mock collector never became ready on $BASE_URL"
fi
log "collector ready"

# --- Run a real Codex session with tracing pointed at the collector --------

# These BRAINTRUST_* vars are read by the hook client (inherited from this
# process via Codex) and bundled into the session's reporting config. Pointing
# both URLs at the collector captures the login handshake and the data POST.
export TRACE_TO_BRAINTRUST=true
export BRAINTRUST_API_KEY=smoke-key
export BRAINTRUST_API_URL="$BASE_URL"
export BRAINTRUST_APP_URL="$BASE_URL"
export BRAINTRUST_PROJECT=trace-codex-smoke
# Keep the background event server short-lived so it doesn't linger after CI.
export BRAINTRUST_EVENT_SERVER_IDLE_TIMEOUT_MS=15000
export BRAINTRUST_EVENT_SERVER_IDLE_CHECK_INTERVAL_MS=1000
# Block on the terminal-event flush so the final spans are delivered before
# `codex exec` returns. Without this the hook just enqueues and relies on the
# server's idle-drain flush, which may not fire before this short-lived run tears
# the process tree down — making the assertion below flaky.
export BRAINTRUST_FLUSH_ON_TURN_END=true

# Pin the release the launcher downloads, when requested. The launcher strips an
# optional leading 'v', so either form is fine here.
if [ -n "$RELEASE_VERSION" ]; then
  export TRACE_CODEX_RELEASE_VERSION="$RELEASE_VERSION"
  log "pinning plugin binary to release $RELEASE_VERSION"
else
  log "using installed plugin manifest version (no pin)"
fi

log "running codex exec (say hi)"
# CODEX_API_KEY is supported only by `codex exec` and is set inline for just
# this invocation. --dangerously-bypass-hook-trust runs the plugin's hooks
# without the interactive /hooks trust prompt (one-off automation escape hatch).
set +e
CODEX_API_KEY="$OPENAI_API_KEY" codex exec \
  --skip-git-repo-check \
  --dangerously-bypass-hook-trust \
  --sandbox read-only \
  "say hi" >"$CODEX_LOG" 2>&1
codex_status=$?
set -e
log "codex exec exited with status $codex_status"
if [ "$codex_status" -ne 0 ]; then
  log "--- codex output (key redacted) ---"
  scrub <"$CODEX_LOG" >&2 || true
fi

# With BRAINTRUST_FLUSH_ON_TURN_END=true (set above), the hook client blocks
# on a synchronous flush at session end, so by the time codex exec returns the
# trace should already be delivered. Stop the collector (via cleanup) to make it
# write its summary, then assert.
cleanup
COLLECTOR_PID=""  # already stopped; avoid double-kill in the EXIT trap

log "--- collector log (key redacted) ---"
scrub <"$COLLECTOR_LOG" >&2 || true

[ -f "$SUMMARY" ] || fail "collector wrote no summary file"
total_rows=$(sed -n 's/.*"totalRows"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$SUMMARY")
[ -n "$total_rows" ] || fail "could not parse totalRows from summary: $(cat "$SUMMARY")"
log "summary: $(cat "$SUMMARY")"

if [ "$total_rows" -ge 1 ]; then
  log "PASS: received $total_rows trace row(s)"
  exit 0
fi

fail "expected >=1 trace row, got $total_rows"
