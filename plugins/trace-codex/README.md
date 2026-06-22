# Braintrust Codex Tracing Plugin

A [Codex plugin](https://developers.openai.com/codex/plugins) that wires Codex lifecycle hooks as a foundation for sending Codex sessions to Braintrust as traces.

## Quickstart

```bash
codex plugin marketplace add braintrustdata/braintrust-codex-plugin
codex plugin add trace-codex@braintrust-codex-plugins
# NOTE: tracing must be explicitly enabled
# upon first run, codex will prompt for plugin permissions
TRACE_TO_BRAINTRUST=true BRAINTRUST_PROJECT=my-coding-agent codex
```

## Configuration

There are two ways to configure the plugin. **Environment variables always win over the config file**

```
cp ~/.codex/plugins/cache/braintrust-codex-plugins/trace-codex/<plugin-version>/config.json.example ~/.codex/plugins/data/trace-codex-braintrust-codex-plugins/config.json
# now edit config.json with your desired settings
```

Every setting can be provided as a `config.json` key or as an environment variable; **an environment variable always overrides config.json**

| `config.json` key    | Environment variable                  | Default            | Meaning                                                                                                                                      |
|----------------------|---------------------------------------|--------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| `traceToBraintrust`  | `TRACE_TO_BRAINTRUST`                 | `false`            | Master switch. **When `false` or unset, no traces are reported** Set `true` to enable tracing.                                               |
| `apiKey`             | `BRAINTRUST_API_KEY`                  | _(unset)_          | Braintrust API key.                                                                                                                          |
| `project`            | `BRAINTRUST_PROJECT`                  | _(unset)_          | Project to log traces into.                                                                                                                  |
| `apiUrl`             | `BRAINTRUST_API_URL`                  | api.braintrust.dev | Braintrust API URL.                                                                                                                          |
| `additionalMetadata` | `BRAINTRUST_ADDITIONAL_METADATA`      | _(unset)_          | JSON object of extra metadata merged into the root span. Standard keys (`session_id`, `model`, `project`, etc.) take precedence on conflict. |
| `blockOnStop`        | `BRAINTRUST_PLUGIN_BLOCK_ON_STOP`     | `false`            | When `true`, the hook blocks on each turn's `Stop` until the server confirms all spans are flushed. Use in programmatic/CI runs to guarantee traces are delivered before Codex exits. |
| `recordFile`         | `BRAINTRUST_EVENT_SERVER_RECORD_FILE` | _(unset)_          | If set, record every event to this NDJSON file (for `replay`).                                                                               |

### Advanced Options

Advanced plugin settings for debugging or developing the plugin


| `config.json` key     | Environment variable                             | Default        | Meaning                                         |
|-----------------------|--------------------------------------------------|----------------|-------------------------------------------------|
| `port`                | `BRAINTRUST_EVENT_SERVER_PORT`                   | `52734`        | Loopback port for the server.                   |
| `idleTimeoutMs`       | `BRAINTRUST_EVENT_SERVER_IDLE_TIMEOUT_MS`        | `300000`       | Idle shutdown window.                           |
| `idleCheckIntervalMs` | `BRAINTRUST_EVENT_SERVER_IDLE_CHECK_INTERVAL_MS` | `30000`        | Idle watchdog cadence.                          |
| _(none)_              | `BRAINTRUST_EVENT_SERVER_LOG_DIR`                | `$PLUGIN_DATA` | Directory for logs, pidfile, and `config.json`. |

The config file is read by the hook client only at the moment it boots the background server (the running server keeps the config it started with). To pick up config changes, stop the server (or wait for it to idle out) so the next event re-boots it.

## Smoke test

`make smoke` runs a full end-to-end check: it starts a local mock Braintrust collector, runs a real `codex exec "say hi"` session with tracing pointed at the mock, and asserts at least one trace row was reported. This exercises the whole path (Codex hook -> background server -> Braintrust SDK flush) without touching a real Braintrust account.

Requirements: `codex` and `bun` on `PATH`, `OPENAI_API_KEY` set, and the plugin installed in Codex (run `../../install.sh trace-codex` for a local dev install).

```bash
OPENAI_API_KEY=sk-... make smoke
# Pin the release whose codex-hook binary the launcher downloads:
OPENAI_API_KEY=sk-... make smoke SMOKE_VERSION=0.0.1
```

CI runs the same smoke test (macOS arm64/x64 and Linux) after every release via `.github/workflows/smoke.yaml`. That workflow can also be dispatched manually from the Actions tab against any published release version.
