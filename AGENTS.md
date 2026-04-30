# AGENTS.md

Guidelines for AI agents working in this repo.

## Repo purpose

This repo packages the [Braintrust MCP server](https://www.braintrust.dev/docs/integrations/developer-tools/mcp) as a [Codex marketplace plugin](https://developers.openai.com/codex/plugins). The key files are:

- `.codex-plugin/plugin.json` — plugin manifest (version, UI metadata, default prompts)
- `.mcp.json` — MCP server definition
- `skills/braintrust/` — agent skills exposed through the plugin

## Making changes

- **Skills**: There is only one simple skill in this repo which handles routing and tool definitions, it should not be modified significantly.
- **MCP config**: edit `.mcp.json` to change the MCP server command or environment variables.
- **Plugin metadata**: edit `.codex-plugin/plugin.json` for display name, description, brand color, default prompts, etc.

## Releasing a new version

1. Bump `"version"` in `.codex-plugin/plugin.json`.
2. Commit, tag, and create a GitHub release (see README for exact commands).
3. Do **not** skip the git tag — releases are tracked via tags so users can see a changelog.
