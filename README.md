# Braintrust tracing for Codex

> **This repository is generated.** It is built from
> [braintrustdata/braintrust-coding-agent-plugins](https://github.com/braintrustdata/braintrust-coding-agent-plugins).
> Don't edit files here — make changes and file issues in that repository, and they
> will be rebuilt into this one.

Trace Codex sessions in Braintrust with the `trace-codex` plugin.

## Quickstart

Install Codex and the
[Braintrust CLI](https://www.braintrust.dev/docs/reference/cli/quickstart), then run:

```bash
bt login
bt trace enable codex --project my-coding-agent
```

Setup adds the published marketplace, installs the plugin, and saves routing
settings in `~/.codex/braintrust.json`. Use `--profile` or `--org` to select a
Braintrust profile or organization. Restart Codex after setup and approve the
Braintrust hook through `/hooks` when prompted.

## What is captured

The daemon builds session, turn, LLM, and tool spans from Codex hooks and
transcripts, including available usage, compaction, and subagent activity.
The plugin forwards events locally; `bt` owns authentication and delivery.

## One-off runs and transcript import

```bash
bt trace run --project my-coding-agent codex -- exec "summarize this repository"
bt trace import codex SESSION_ID
bt trace import codex SESSION_ID --attach
```

`run` leaves your saved settings alone. `import` reads a saved transcript;
`--attach` follows it until Ctrl-C. Imports include only what the agent recorded.

## Manage tracing

```bash
bt trace doctor codex
bt trace status
bt trace update codex
bt trace disable codex
```

See the [tracing plugin guide](plugins/trace-codex/README.md) for hook behavior,
metadata, and tags. This marketplace does not configure the Braintrust MCP
server; use the agent's connector or MCP configuration for MCP access.
