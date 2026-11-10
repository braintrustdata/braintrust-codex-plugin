# Braintrust plugins for Codex

> **This repository is generated.** It is built from
> [braintrustdata/braintrust-coding-agent-plugins](https://github.com/braintrustdata/braintrust-coding-agent-plugins).
> Don't edit files here — make changes and file issues in that repository, and they
> will be rebuilt into this one.

This marketplace contains two independently opt-in plugins:

- **Braintrust**, `braintrust@braintrust-codex-plugins`: hosted MCP tools with
  OAuth. No `bt` dependency or tracing hooks. See the
  [MCP installation and endpoint guide](plugins/braintrust/README.md).
- **Trace Codex**, `trace-codex@braintrust-codex-plugins`: session tracing via `bt`.

For MCP, add this marketplace and select Braintrust:

```bash
codex plugin marketplace add braintrustdata/braintrust-codex-plugin
codex plugin add braintrust@braintrust-codex-plugins
```

The GitHub package connects to NA (US). EU and custom deployments require an
admin-configured local/team copy; GitHub installs do not inherit public portal
template settings. The planned public-directory listing uses one template,
pending OpenAI eligibility and endpoint-template confirmation. Its concrete NA
review URL is not a verified install-time default.

The sections below describe optional tracing setup only.

## Quickstart

Install Codex and the
[Braintrust CLI](https://docs.braintrust.dev/reference/cli/quickstart), then run:

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
metadata, and tags. MCP sign-in and `bt` tracing sign-in are independent.
