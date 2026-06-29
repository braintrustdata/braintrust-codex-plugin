# Braintrust Codex Tracing Plugin

A [Codex plugin](https://developers.openai.com/codex/plugins) that wires Codex lifecycle hooks as a foundation for sending Codex sessions to Braintrust as traces.

## Quickstart

```bash
codex plugin marketplace add braintrustdata/braintrust-codex-plugin
codex plugin add trace-codex@braintrust-codex-plugins
# NOTE: tracing must be explicitly enabled
# upon first run, codex will prompt for plugin permissions
TRACE_TO_BRAINTRUST=true BRAINTRUST_PROJECT=my-coding-agent codex
# to upgrade:
codex plugin marketplace upgrade braintrust-codex-plugins
```

## Using the plugin in CI

Tracing `codex exec` runs in CI works. A few notes:

- **Block on flush.** Set `BRAINTRUST_FLUSH_ON_TURN_END=true` so the final spans are delivered before the job exits (a short-lived CI job can otherwise tear down before the background server's idle-drain flush fires).
- **Trust the hooks non-interactively.** Pass `codex exec --dangerously-bypass-hook-trust` to skip the one-time interactive hook-trust prompt. (Only for plugins you trust.)

GitHub Actions example:

```yaml
name: codex-traced
on: [workflow_dispatch]

jobs:
  run:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Install Codex CLI
        run: npm install -g @openai/codex   # or your preferred install method

      - name: Install the trace-codex plugin (pinned to a release tag)
        # TODO: replace with desired version ---------------------------------vvvvvvvvvvvvvvvvvv
        run: |
          codex plugin marketplace add braintrustdata/braintrust-codex-plugin@trace-codex-v0.0.X
          codex plugin add trace-codex@braintrust-codex-plugins

      - name: Run a traced Codex session
        env:
          TRACE_TO_BRAINTRUST: "true"
          BRAINTRUST_API_KEY: ${{ secrets.BRAINTRUST_API_KEY }}
          BRAINTRUST_PROJECT: my-coding-agent # <--- TODO: replace with your project name
          BRAINTRUST_FLUSH_ON_TURN_END: "true"
        run: |
          codex exec \
            --skip-git-repo-check \
            --dangerously-bypass-hook-trust \
            --sandbox read-only \
            "summarize the changes in this repo"
```

If your plugin release repo is private, also expose a token the launcher can use to download the binary (`GH_TOKEN` or `GITHUB_TOKEN`, or an authenticated `gh`).

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
| `flushOnTurnEnd`     | `BRAINTRUST_FLUSH_ON_TURN_END`        | `false`            | When `true`, the hook blocks at each turn's end (the `Stop` event) until the server confirms all spans are flushed. Use in programmatic/CI runs to guarantee traces are delivered before Codex exits. |
| `recordFile`         | `BRAINTRUST_EVENT_SERVER_RECORD_FILE` | _(unset)_          | If set, record every event to this NDJSON file (for `replay`).                                                                               |

### Resuming sessions

Note that when resuming a session, the original session's options will remain in effect.

For example:

```sh
TRACE_TO_BRAINTRUST=true codex # first session enables braintrust
TRACE_TO_BRAINTRUST=false codex resume abcde # the resumed session will still be traced because the original session was
```

The trace itself also survives the background server stopping. The server shuts down after the idle window (or on an explicit shutdown), but a session can outlive it — you might leave it open past the timeout, send another message after the server stopped, or `codex resume` later. The plugin snapshots each session's in-progress trace state under `$PLUGIN_DATA/state/` and restores it when the session continues, so later turns keep landing in the same trace instead of starting a new one. Stale snapshots age out automatically, and secrets (your API key) are never written to them.

### Advanced Options

Advanced plugin settings for debugging or developing the plugin


| `config.json` key     | Environment variable                             | Default        | Meaning                                         |
|-----------------------|--------------------------------------------------|----------------|-------------------------------------------------|
| `port`                | `BRAINTRUST_EVENT_SERVER_PORT`                   | `52734`        | Loopback port for the server.                   |
| `idleTimeoutMs`       | `BRAINTRUST_EVENT_SERVER_IDLE_TIMEOUT_MS`        | `300000`       | Idle shutdown window.                           |
| `idleCheckIntervalMs` | `BRAINTRUST_EVENT_SERVER_IDLE_CHECK_INTERVAL_MS` | `30000`        | Idle watchdog cadence.                          |
| _(none)_              | `BRAINTRUST_EVENT_SERVER_LOG_DIR`                | `$PLUGIN_DATA` | Directory for logs, pidfile, and `config.json`. |

The config file is read by the hook client only at the moment it boots the background server (the running server keeps the config it started with). To pick up config changes, stop the server (or wait for it to idle out) so the next event re-boots it.
