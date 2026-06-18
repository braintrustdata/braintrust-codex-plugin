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
