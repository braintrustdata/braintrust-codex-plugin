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

### Selecting the CLI executable

Hooks resolve `bt` from the Codex process's PATH. With version managers such as
mise, that can select a different version depending on the working directory.
Set `BRAINTRUST_BT_BIN` to the absolute path of the actual CLI executable to
delegate hook capture to a fixed version:

```bash
export BRAINTRUST_BT_BIN="/absolute/path/to/bt"
codex
```

Codex must inherit this variable; GUI launches may need separate environment
configuration. Point it at an executable rather than a version-manager shim.
The PATH-resolved `bt` must also be upgraded to a release supporting delegation:
older releases cannot honor this setting (versions before 0.16 lack `trace`
entirely). A missing or invalid target reports an error instead of silently
falling back. The marketplace hook definition stays unchanged.

## Setup

Install and configure the published plugin with the Braintrust CLI:

```bash
bt trace enable codex --project my-coding-agent
```

Use `--profile` or `--org` when needed. Setup activates Braintrust tracing in
Codex. Restart Codex after setup so it loads the plugin. `bt trace update codex`
refreshes the plugin and reapplies its setup.

If setup reports an error, update Codex and `bt`, then retry. Use
`bt trace doctor codex` to inspect route, authentication, daemon, and plugin
diagnostics.

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
