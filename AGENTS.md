# AGENTS.md

Guidelines for AI agents working in this repo.

## Repo purpose

This repo distributes one [Codex marketplace plugin](https://developers.openai.com/codex/plugins):

- `plugins/trace-codex/` — an opt-in plugin that traces Codex sessions to Braintrust (session, turn, and tool spans) via Codex lifecycle hooks.

The plugin is listed in `.agents/plugins/marketplace.json` (the repo marketplace).

Key files for the tracing plugin (see [`plugins/trace-codex/AGENTS.md`](plugins/trace-codex/AGENTS.md) for its architecture):

- `plugins/trace-codex/AGENTS.md` — architecture and contributor guide for this plugin
- `plugins/trace-codex/.codex-plugin/plugin.json` — plugin manifest
- `plugins/trace-codex/hooks/hooks.json` — lifecycle hook config
- `plugins/trace-codex/src/` — the hook client + event server (compiled to `bin/codex-hook`)

## Making changes

- **Plugin metadata**: edit `plugins/trace-codex/.codex-plugin/plugin.json`.
- **Marketplace**: edit `.agents/plugins/marketplace.json` to change the plugin entry, category, or install policy.

## Releasing a new version

1. Bump `"version"` in the relevant plugin's `.codex-plugin/plugin.json`.
2. Commit, tag, and create a GitHub release (see README for exact commands).
3. Do **not** skip the git tag — releases are tracked via tags so users can see a changelog.
