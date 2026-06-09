# AGENTS.md

Guidelines for AI agents working in this repo.

## Repo purpose

This repo is a monorepo of two independent [Codex marketplace plugins](https://developers.openai.com/codex/plugins):

- `plugins/braintrust-codex-plugin/` — packages the [Braintrust MCP server](https://www.braintrust.dev/docs/integrations/developer-tools/mcp) plus a routing skill.
- `plugins/trace-codex/` — an opt-in plugin that traces Codex sessions to Braintrust (session, turn, and tool spans) via Codex lifecycle hooks. Do **not** merge tracing behavior into the MCP/skills plugin; they are separate, independently installable plugins.

Both plugins are listed as separate entries in `.agents/plugins/marketplace.json` (the repo marketplace).

Key files for the MCP/skills plugin:

- `plugins/braintrust-codex-plugin/.codex-plugin/plugin.json` — plugin manifest (version, UI metadata, default prompts)
- `plugins/braintrust-codex-plugin/.mcp.json` — MCP server definition
- `plugins/braintrust-codex-plugin/skills/braintrust/` — agent skills exposed through the plugin

Key files for the tracing plugin:

- `plugins/trace-codex/.codex-plugin/plugin.json` — plugin manifest
- `plugins/trace-codex/hooks/hooks.json` — lifecycle hook config
- `plugins/trace-codex/src/` — the hook client + event server (compiled to `bin/codex-hook`)

## Making changes

- **Skills**: There is only one simple skill in this repo which handles routing and tool definitions, it should not be modified significantly.
- **MCP config**: edit `plugins/braintrust-codex-plugin/.mcp.json` to change the MCP server command or environment variables.
- **Plugin metadata**: edit the relevant `.codex-plugin/plugin.json` for display name, description, brand color, default prompts, etc.
- **Marketplace**: edit `.agents/plugins/marketplace.json` to change plugin entries, categories, or install policies.

## Releasing a new version

1. Bump `"version"` in the relevant plugin's `.codex-plugin/plugin.json`.
2. Commit, tag, and create a GitHub release (see README for exact commands).
3. Do **not** skip the git tag — releases are tracked via tags so users can see a changelog.
