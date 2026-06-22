# AGENTS.md — trace-codex

Guidelines for AI agents working in the `trace-codex` plugin. This is the
opt-in plugin that traces Codex sessions to Braintrust. It is **independent**
from the MCP/skills plugin (`braintrust-codex-plugin`) — do not merge behavior
between them. See the [repo AGENTS.md](../../AGENTS.md) for the monorepo
overview.

## What this plugin is

A long-lived, local **event server** plus a short-lived **hook client**, both
compiled into a single `codex-hook` binary. Codex fires lifecycle hooks; each
hook invocation runs the client, which forwards the event to the server, which
turns the stream of events into Braintrust spans (session → turn → tool).

## Architecture

Request/data flow:

```
Codex hook → bin/codex-hook.sh → codex-hook (client mode)
          → POST /enqueue → in-memory FIFO queue
          → ProcessorRegistry (one EventProcessor per session)
          → Braintrust spans
```

Key pieces:

- `src/index.ts` — entry point. One binary, three modes: `serve` (the
  background server), `hook` (default; read one event from stdin, enqueue it),
  and `replay` (re-POST a recorded NDJSON session).
- `src/client/` — the hook client. Ensures a server is up (booting a detached
  one if needed), POSTs events, and on a terminal event (`Stop`) calls `/flush`
  so final spans are delivered before the process tree is torn down.
- `src/server/` — the HTTP server, the FIFO `EventQueue`, routes
  (`/enqueue`, `/flush`, `/health`, `/shutdown`), and the idle watchdog.
- `src/processor/` — the generic `ProcessorRegistry` (LRU map of per-session
  processors) and the `EventProcessor` interface.
- `src/agents/codex/` — Codex-specific: translate hook payloads into
  `EnqueueEvent`s (`event-builder.ts`), build spans (`event-processor.ts`), and
  read user settings (`settings.ts`).
- `src/braintrust/` — thin wrapper over the Braintrust SDK (span factory).

The server is **single-version**: a client whose version doesn't match a running
server bails rather than talking to it. It shuts itself down after an idle
window (default 5 min) or on `/shutdown`.

The design has three deliberate properties worth understanding before changing
anything:

### 1. Agent-agnostic "event server"

The core (`src/server/`, `src/processor/`, `src/braintrust/`) knows nothing
about Codex. It speaks a generic `EnqueueEvent` shape and routes events to a
per-session processor. All Codex-specific knowledge lives in `src/agents/codex/`
and is registered into the generic core at startup. Adding another agent (Claude
Code, opencode, etc.) means adding a sibling `src/agents/<agent>/` module that
exports the same `Agent` shape — the server, queue, and registry should not need
to change.

Keep this boundary clean: nothing under `src/server/`, `src/processor/`, or
`src/braintrust/` should reference Codex by name. The generic event server may
eventually be extracted into its own package, so treat any Codex-specific leak
into the generic layers as a bug, not a shortcut.

### 2. Bun-compiled, cross-platform binaries

The hook command in `hooks.json` is a fixed, platform-agnostic string that
invokes `bin/codex-hook.sh` (or `.cmd` on Windows), **not** the binary directly.
That launcher resolves and runs the real, platform-specific `codex-hook` binary.

- `scripts/build.ts` compiles `src/index.ts` with `bun build --compile` for each
  target (`darwin-arm64/x64`, `linux-x64/arm64`; Windows slots in but isn't
  built yet). `BUILD_HOST_ONLY=1` builds just the host target (used by the
  repo-root `install.sh` for local dev installs).
- The compiled binaries are **large and not committed**. The launcher downloads
  the matching binary from the plugin's GitHub release on first use and caches
  it at `$PLUGIN_ROOT/bin/codex-hook`. Codex wipes `$PLUGIN_ROOT` on every
  install/upgrade, so the cache self-invalidates and the next hook re-downloads
  the right version.
- Plugin version is the single source of truth in
  `.codex-plugin/plugin.json`; the launcher reads it to construct the release
  tag (`trace-codex-v<version>`).

**Hard rule:** the hook must never fail the Codex turn. The launcher and client
log to stderr and exit 0 on any error; the server swallows errors so a turn is
never blocked by tracing.

### 3. Hooks are non-blocking by default

Tracing must not degrade the experience of using the coding agent. Every hook
fires synchronously in Codex's path, so blocking work on a hook directly adds
latency to the user's session. The design therefore makes the common path
fire-and-forget: the client POSTs to `/enqueue` and returns immediately, while
the background server does the slow work (Braintrust SDK calls, flushes) off the
critical path.

We **deliberately block in a few places**, and only where correctness requires
it:

- On a **terminal event** (`Stop`), the client calls `/flush` and waits for the
  server to confirm buffered spans reached Braintrust. Without this, a
  short-lived host (e.g. a CI job that ends right after the last turn) would tear
  the process tree down before the final spans are delivered. This is the one
  routine blocking point, and it's bounded by a timeout (`/flush` gives up rather
  than hanging the turn).

When adding behavior, prefer enqueue-and-return. Reach for a blocking
request/await only when data would otherwise be lost, keep it off the
per-hook hot path where possible, and always bound it so a slow or stuck backend
can't stall the agent.

## Making changes

- **Generic vs. agent code**: put agent-specific logic in `src/agents/<agent>/`;
  keep the server/processor/braintrust layers agent-agnostic.
- **Config**: two layers. The agent-specific layer (`src/agents/codex/settings.ts`)
  reads the user's `config.json` from `PLUGIN_DATA`, maps its friendly camelCase
  keys onto `BRAINTRUST_*` / `BRAINTRUST_EVENT_SERVER_*` env vars (env wins over
  the file), and is run by the hook client before it boots the server — so the
  spawned server inherits the resolved env. The generic layer (`src/config.ts`)
  then reads **only** those env vars and never touches `config.json`. Keep it
  that way: config-file parsing is deliberately agent-specific. User-facing
  settings are documented in the [README](./README.md); update it (and the
  `Settings` map in `settings.ts`) when adding one.
- **Hooks**: `hooks/hooks.json` lists the lifecycle events wired to the client.
  Most are forwarded but not yet turned into spans (the processor no-ops the
  ones it doesn't handle).
- **Build**: edit `scripts/build.ts` for targets/output; the launcher scripts
  (`bin/codex-hook.sh`, `bin/codex-hook.cmd`) for download/exec behavior.

## Commands

Run from `plugins/trace-codex/`:

- `bun test` — run the test suite (tests live next to sources as `*.test.ts`).
- `bun run typecheck` — `tsc --noEmit`.
- `bun run lint` / `bun run check` — Biome lint / lint+format.
- `bun run build` — compile all target binaries (`BUILD_HOST_ONLY=1` for host
  only).
- `bun run dev` — run the server in watch mode.

Add or update tests alongside any behavior change; keep typecheck and lint
clean.
