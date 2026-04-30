# Braintrust Codex Plugin

> **This repository is generated.** It is built from
> [braintrustdata/braintrust-coding-agent-plugins](https://github.com/braintrustdata/braintrust-coding-agent-plugins).
> Don't edit files here — make changes and file issues in that repository, and they
> will be rebuilt into this one.

Daemon-backed Braintrust session tracing for [Codex](https://developers.openai.com/codex/plugins).

## Quickstart

Add this repo as a Codex plugin marketplace:

```bash
codex plugin marketplace add braintrustdata/braintrust-codex-plugin
codex plugin add trace-codex@braintrust-codex-plugins
```

The recommended tracing setup is:

```bash
bt trace enable codex --project my-coding-agent
```

This installs the tracing plugin and stores only non-secret routing settings.
The `bt` CLI owns authentication and forwards hook events through the shared
daemon. Restart Codex after setup.

## trace codex plugin

See the plugin's [README](/plugins/trace-codex/README.md) for details.

This marketplace does not install or configure the Braintrust MCP server. Use
Codex's native connector or MCP configuration when you want MCP access.
