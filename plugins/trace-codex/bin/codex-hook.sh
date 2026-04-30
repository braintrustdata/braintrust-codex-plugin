#!/bin/bash
# Thin, fail-open bridge from Codex hooks to the shared Braintrust daemon.

BT_INSTALL_URL="https://bt.dev/cli/install.sh"

resolve_bt() {
  if command -v bt >/dev/null 2>&1; then
    command -v bt
    return 0
  fi

  local candidate
  for candidate in \
    "${XDG_BIN_HOME:-${HOME:-}/.local/bin}/bt" \
    "${CARGO_HOME:-${HOME:-}/.cargo}/bin/bt"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

BT_BIN="$(resolve_bt || true)"
if [[ -z "$BT_BIN" ]]; then
  if ! command -v curl >/dev/null 2>&1; then
    printf 'trace-codex: curl is required to install bt; tracing skipped\n' >&2
    exit 0
  fi

  printf 'trace-codex: bt CLI not found; installing it now\n' >&2
  if ! (set -o pipefail; curl -fsSL "$BT_INSTALL_URL" | bash) >&2; then
    printf 'trace-codex: bt installation failed; tracing skipped\n' >&2
    exit 0
  fi

  BT_BIN="$(resolve_bt || true)"
  if [[ -z "$BT_BIN" ]]; then
    printf 'trace-codex: bt was installed but is not executable; tracing skipped\n' >&2
    exit 0
  fi
fi

"$BT_BIN" trace hook --source codex || true
exit 0
