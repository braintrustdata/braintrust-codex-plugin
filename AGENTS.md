# AGENTS.md

Guidelines for AI agents working in this repo.

## Repo purpose

This generated repo distributes two independently opt-in
[Codex marketplace plugins](https://developers.openai.com/plugins/build/plugins):

- `plugins/braintrust/` — hosted MCP with OAuth DCR, portable root `plugin.json`
  and `mcp.json`. No hooks, apps, skills, credentials, or local runtime.

- `plugins/trace-codex/` — an opt-in plugin that traces Codex sessions to Braintrust (session, turn, and tool spans) via Codex lifecycle hooks.

Both plugins are listed in `.agents/plugins/marketplace.json`. Preserve the
marketplace name `braintrust-codex-plugins` and tracing identity
`trace-codex@braintrust-codex-plugins`.

Key files for the tracing plugin:

- `plugins/trace-codex/README.md` — architecture and setup guide
- `plugins/trace-codex/.codex-plugin/plugin.json` — plugin manifest
- `plugins/trace-codex/hooks/hooks.json` — lifecycle hook config
- Tracing hooks forward to `bt trace hook --source codex`; there is no bundled runtime.

## Making changes

- **MCP metadata**: edit `plugins/braintrust/plugin.json` and `mcp.json` in the
  source monorepo. Keep portable identity and OpenAI presentation in one manifest.
  Keep server-level auth extensions out of the Codex `mcp.json`: current Codex
  rejects them. The monorepo ZIP builder adds OAuth DCR metadata only to the
  OpenAI submission archive and validates both formats separately.
- **Plugin metadata**: edit `plugins/trace-codex/.codex-plugin/plugin.json`.
- **Marketplace**: edit `.agents/plugins/marketplace.json` to change the plugin entry, category, or install policy.

## Releasing a new version

Make all source changes in `braintrustdata/braintrust-coding-agent-plugins`.
Both packages share the Codex distribution version. Use the monorepo's reviewed
Release Plugin workflow; do not edit or tag this generated repository manually.
The distribution release carries an MCP-only ZIP for manual OpenAI submission.
Template settings belong to portal setup, not speculative manifest fields.
