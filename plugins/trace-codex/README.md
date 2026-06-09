# Braintrust Codex Tracing Plugin

A separate, opt-in [Codex plugin](https://developers.openai.com/codex/plugins) that wires Codex lifecycle hooks as a foundation for sending Codex sessions to Braintrust as traces.

It is **opt-in** (you must install and enable it) and **requires no Braintrust credentials yet** — it makes no network calls beyond a local loopback connection.

> This is a different plugin from the Braintrust MCP/skills plugin (`braintrust`). The two are independent and can be installed separately. See the [repo README](../../README.md).

## Architecture

Codex invokes a hook as a **fresh, short-lived process per event**, but a trace spans the whole session. To bridge that, the plugin has two parts in one compiled binary (`bin/codex-hook`):

- **Hook client** (`codex-hook hook`, the default): what Codex runs on every lifecycle event. It reads the hook event JSON from stdin, ensures the background server is running (booting it if needed), POSTs the event to the server, and exits. It never fails the Codex turn.
- **Background server** (`codex-hook serve`): a long-lived local HTTP server, bound to loopback, that receives events and (in a later phase) turns them into Braintrust spans. It shuts itself down after a configurable idle period.

Every Codex hook event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`) is wired to the hook client.

### Multi-agent layout

The code is split into a generic, agent-agnostic core and per-agent modules so other coding agents (e.g. Claude Code) can be added without touching the core:

- **Generic core**: `src/server/` (HTTP event server, queue, recorder), `src/processor/` (the `EventProcessor`/`EventProcessorFactory` interface + LRU registry), `src/client/` (server lifecycle + the run loop), `src/braintrust/`, `src/config.ts`, `src/replay/`. The registry is keyed by `eventSource` and never names a specific agent.
- **Per-agent modules**: `src/agents/<agent>/`. The Codex module (`src/agents/codex/`) contains its `event-processor.ts` (events → spans), `event-builder.ts` (raw stdin → generic `EnqueueEvent`), `settings.ts` (reads its `config.json`), and `register.ts` exporting a `codexAgent` object.

To add an agent: create `src/agents/<agent>/` implementing the same surface (`eventSource`, `createProcessor`, `buildEvent`, `loadSettings`) and add it to the `AGENTS` list in `src/index.ts`. No changes to the core are required.

### Server endpoints (Phase 1)

- `GET /health` → `{ "version": "<plugin version>" }`. Returns `503` while shutting down.
- `POST /enqueue` → body `{ eventSource, eventSourceVersion, eventName, eventData }`. Currently logs and no-ops; returns `{ "ok": true }`. Returns `503` while shutting down.
- `POST /shutdown` → marks the server as shutting down (subsequent `/health` and `/enqueue` return `503`) and stops gracefully. Returns `200` with an empty body.

The server tracks a heartbeat (bumped on every request) and shuts down after an idle timeout (default 5 minutes).

## Configuration

There are two ways to configure the plugin. **Environment variables always win over the config file**, so you can override any file setting at runtime or in CI.

### `config.json` (recommended)

Codex does not pass custom settings into plugin hooks, so the plugin reads its own `config.json` from the plugin's writable data directory (`PLUGIN_DATA`):

```
~/.codex/plugins/data/trace-codex-<marketplace>/config.json
```

Copy [`config.json.example`](./config.json.example) into that directory as `config.json` and edit it by hand. All keys are optional:

| Key | Maps to env var | Meaning |
| --- | --- | --- |
| `traceToBraintrust` | `TRACE_TO_BRAINTRUST` | Master switch. **When `false` or unset, no traces are reported** (events are dropped). Set `true` to enable tracing. |
| `apiKey` | `BRAINTRUST_API_KEY` | Braintrust API key. |
| `apiUrl` | `BRAINTRUST_API_URL` | Braintrust API URL (for self-hosted / staging). |
| `appUrl` | `BRAINTRUST_APP_URL` | Braintrust app URL. |
| `project` | `BRAINTRUST_PROJECT` | Project to log traces into. |
| `additionalMetadata` | `BRAINTRUST_ADDITIONAL_METADATA` | JSON object of extra metadata merged into the root span. Standard keys (`session_id`, `model`, `project`, etc.) take precedence on conflict. |
| `recordFile` | `BRAINTRUST_EVENT_SERVER_RECORD_FILE` | If set, record every event to this NDJSON file (for `replay`). |
| `port` | `BRAINTRUST_EVENT_SERVER_PORT` | Loopback port for the server. |
| `idleTimeoutMs` | `BRAINTRUST_EVENT_SERVER_IDLE_TIMEOUT_MS` | Idle shutdown window. |
| `idleCheckIntervalMs` | `BRAINTRUST_EVENT_SERVER_IDLE_CHECK_INTERVAL_MS` | Idle watchdog cadence. |

> By default tracing is **off**. Set `traceToBraintrust: true` (or `TRACE_TO_BRAINTRUST=true`) to start reporting.

The config file is read by the hook client only at the moment it boots the background server (the running server keeps the config it started with). To pick up config changes, stop the server (or wait for it to idle out) so the next event re-boots it.

### Environment variables

Every setting above can also be set directly as an environment variable (and an env var overrides the file). Defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRAINTRUST_EVENT_SERVER_PORT` | `52734` | Loopback port for the server. |
| `BRAINTRUST_EVENT_SERVER_IDLE_TIMEOUT_MS` | `300000` | Idle shutdown window. |
| `BRAINTRUST_EVENT_SERVER_IDLE_CHECK_INTERVAL_MS` | `30000` | Idle watchdog cadence. |
| `BRAINTRUST_EVENT_SERVER_LOG_DIR` | `$PLUGIN_DATA` | Directory for logs, pidfile, and `config.json`. |
| `BRAINTRUST_EVENT_SERVER_RECORD_FILE` | _(unset)_ | Record events to this NDJSON file. |

## Binary distribution (launcher)

The compiled binary is ~56 MB per platform, far too large to commit. Codex installs a plugin by cloning/copying only the committed repo files (no build step), so the binary is fetched at runtime instead:

- `hooks/hooks.json` invokes a small committed launcher script, `bin/codex-hook.sh` (and `bin/codex-hook.cmd` on Windows via `commandWindows`).
- On each hook, the launcher looks for `${PLUGIN_ROOT}/bin/codex-hook`. If present, it `exec`s it (fast path: a file check + exec, no version parsing). If missing, it detects the platform (`uname`), reads the plugin version from `${PLUGIN_ROOT}/.codex-plugin/plugin.json` (single source of truth), downloads the matching `codex-hook-<os>-<arch>` asset from the GitHub release `trace-codex-v<version>`, caches it at `${PLUGIN_ROOT}/bin/codex-hook`, and execs it.
- **Upgrades self-heal**: Codex wipes the versioned plugin cache (`${PLUGIN_ROOT}`) on upgrade, so the cached binary is automatically invalidated; the next hook re-downloads the matching version. No manual step.
- The launcher never fails the Codex turn: any download/exec error logs to stderr and exits 0 (tracing simply does nothing that session).

Supported platforms: macOS (arm64/x64) and Linux (x64/arm64). Windows currently prints a "coming soon" message and no-ops.

> **Publishing prerequisite:** the release assets must be **anonymously downloadable**, i.e. the repo must be public. For a private repo the launcher's download will 404 and tracing will no-op. Local dev is unaffected (the locally built `bin/codex-hook` is used directly).

## Build & install (dev)

Requires [Bun](https://bun.sh). From the repo root:

```bash
./install.sh trace-codex   # builds the host binary, then installs
```

After editing source, re-run `./install.sh trace-codex` to rebuild and re-sync the Codex plugin cache.

## Trust

Plugin-bundled hooks are non-managed. Installing/enabling the plugin does **not** auto-trust the hooks; Codex skips them until you review and trust them. Run `/hooks` in the Codex CLI and trust the `trace-codex` hooks. This is **one-time per hook definition** — you are only re-prompted if the command string in `hooks/hooks.json` changes. (Rebuilding the binary does not change the command string, so it does not re-trigger trust.)

## Local testing

```bash
bun test                              # unit tests
bun run typecheck
echo '{"hook_event_name":"SessionStart"}' | bun run src/index.ts hook   # run the client
bun run src/index.ts serve            # run the server in the foreground
```
