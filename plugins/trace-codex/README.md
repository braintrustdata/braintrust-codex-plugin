# Braintrust Codex tracing plugin

This plugin forwards Codex lifecycle hook payloads to the shared Braintrust
tracing daemon through:

```text
bt trace hook --source codex
```

The plugin is intentionally a thin, fail-open adapter. Its launcher installs
the `bt` CLI with the official installer when it is not already available, then
forwards the event. The `bt` CLI owns authentication, configuration, event
journaling, trace construction, and delivery to Braintrust. No credentials are
stored in the plugin.

## Setup

Install and configure the published plugin with the Braintrust CLI:

```bash
bt trace enable codex --project my-coding-agent
```

Use `--profile` or `--org` when needed. Restart Codex after setup so it loads
the plugin. Codex will apply its normal hook-review flow; approve the stable
Braintrust hook definition through `/hooks` when prompted.

To verify the daemon path is available:

```bash
bt trace hook --help
bt trace status
```

Hook setup or forwarding never fails a Codex turn. If installation fails or the
daemon cannot accept an event, the launcher reports a bounded diagnostic and
exits successfully.

## Additional root metadata

For a persistent route, pass a JSON object to `bt trace enable codex
--additional-metadata '<JSON>'` to tag the root span of every Codex session.
Standard session metadata takes precedence if keys conflict.

For one invocation without changing the persistent configuration, use
`bt trace run --additional-metadata '{"ci":true,"run_id":"abc-123"}' codex`,
or set `BRAINTRUST_ADDITIONAL_METADATA` before that command (`bt trace run`
still accepts it; a launched `codex` session's live hooks do not).
