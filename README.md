# Braintrust Codex Plugin

A [Codex plugin](https://developers.openai.com/codex/plugins) that connects the Braintrust MCP server to the Codex marketplace, enabling agents to query Braintrust evals, logs, experiments, datasets, prompts, and traces.

## Local setup

Follow the [Codex plugin local install guide](https://developers.openai.com/codex/plugins/build#install-a-local-plugin-manually) to sideload this plugin.

A reference PR showing a working local setup: https://github.com/braintrustdata/braintrust/pull/13536

Once installed it should look like this:

<img width="1067" height="1229" alt="image" src="https://github.com/user-attachments/assets/b9acaa81-3f95-4164-b65e-17355fc69f5b" />

## Contributing

When adding or modifying a skill, update the skill files under `skills/braintrust/` and test locally before opening a PR.

## Releasing

1. Bump the version in `.codex-plugin/plugin.json`:
   ```json
   { "version": "0.2.0" }
   ```

2. Commit the version bump:
   ```bash
   git add .codex-plugin/plugin.json
   git commit -m "chore: bump version to 0.2.0"
   ```

3. Create a git tag and GitHub release:
   ```bash
   git tag v0.2.0
   git push origin main --tags
   gh release create v0.2.0 --title "v0.2.0" --notes "Describe what changed"
   ```

Users can see the changelog via [GitHub Releases](https://github.com/braintrustdata/braintrust-codex-plugin/releases).

To make the repo public, ping **#wg-infra** or **#eng** on Slack.
