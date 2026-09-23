# Braintrust Codex tracing plugin

This plugin forwards Codex lifecycle hook payloads to the shared Braintrust
tracing daemon through:

```text
bt trace hook --source codex
```

The plugin invokes the installed `bt` CLI directly for each hook. Install `bt`
before enabling the plugin; it owns authentication, configuration, event
journaling, trace construction, and delivery to Braintrust. It discovers the
installed plugin and Codex versions dynamically. No credentials are stored in
the plugin.

## Setup

Install and configure the published plugin with the Braintrust CLI:

```bash
bt trace enable codex --project my-coding-agent
```

Use `--profile` or `--org` when needed. Restart Codex after setup so it loads
the plugin. Codex will apply its normal hook-review flow; approve the stable
Braintrust hook definition through `/hooks` when prompted.

To inspect tracing configuration and daemon status:

```bash
bt trace doctor codex
bt trace status
```

Hook setup or forwarding never fails a Codex turn. If the CLI is unavailable or
the daemon cannot accept an event, Codex reports the hook failure and continues.

## Additional root metadata

For a persistent route, pass a JSON object to `bt trace enable codex
--additional-metadata '<JSON>'` to tag the root span of every Codex session.
Standard session metadata takes precedence if keys conflict.

For one invocation without changing the persistent configuration, use
`bt trace run --additional-metadata '{"ci":true,"run_id":"abc-123"}' codex`,
or set `BRAINTRUST_ADDITIONAL_METADATA` before that command (`bt trace run`
still accepts it; a launched `codex` session's live hooks do not).

## Tags and diagnostics

Use repeatable `--tag` flags for filterable root-span tags. Inspect the effective
configuration with `doctor` and delivery state with `status`:

```bash
bt trace enable codex --tag coding-agent --tag development
bt trace doctor codex
bt trace status
```

See the [distribution guide](../../README.md) for installation, one-off runs,
transcript import, updates, and disablement.
