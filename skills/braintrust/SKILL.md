---
name: braintrust
description: Use the official Braintrust MCP server to search Braintrust docs, inspect projects, query logs and experiments, summarize eval results, and generate permalinks.
---

# Braintrust

Use this skill when the user asks to work with Braintrust data, documentation, experiments, datasets, prompts, logs, traces, evals, or SDK setup.

## Primary MCP server

Use the `braintrust` MCP server.

Default US data plane URL:

`https://api.braintrust.dev/mcp`

EU data plane URL:

`https://api-eu.braintrust.dev/mcp`

Self-hosted URL:

Use the organization's configured Braintrust API URL with `/mcp`.

## Authentication

Prefer the plugin-provided OAuth flow for the remote MCP server.

Braintrust also supports API-key bearer authentication. In Codex TOML, the verified configuration is:

```toml
[mcp_servers.braintrust]
url = "https://api.braintrust.dev/mcp"
bearer_token_env_var = "BRAINTRUST_API_KEY"
```

Never print or expose the API key.

## Tool guide

Use `search_docs` for Braintrust documentation questions.

Use `docs://sdk-install` before `search_docs` when the user asks to install Braintrust, set up tracing, add observability, or configure an eval.

Use `resolve_object` to convert Braintrust names, IDs, and URLs into object metadata.

Use `list_recent_objects` to discover accessible projects, experiments, datasets, prompts, functions, and other recent objects.

Use `infer_schema` before writing SQL when the available fields are unclear.

Use `sql_query` to query experiments, datasets, project logs, traces, and summaries.

Use `summarize_experiment` for aggregate experiment metrics and baseline comparisons.

Use `generate_permalink` when the user needs a shareable Braintrust link.

## Workflow guidance

For production debugging, first resolve the relevant project or object, infer schema if needed, query logs with `sql_query`, then generate permalinks for important traces.

For experiment analysis, list or resolve the experiment, summarize it, compare against a baseline when available, then use SQL for row-level examples.

For documentation and setup, read `docs://sdk-install` for SDK installation tasks and use `search_docs` for follow-up details.

## CLI versus MCP

Use MCP when the user wants conversational exploration of Braintrust data or docs.

Prefer the `bt` CLI for repeatable workflows, CI gates, running evals, scripted operations, and setup flows that should be deterministic.

The Braintrust MCP is currently best treated as read-oriented. Do not invent write capabilities.
