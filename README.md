# Braintrust Codex Plugins

This repo is a monorepo of Braintrust [Codex plugins](https://developers.openai.com/codex/plugins)

## Quickstart

Add this repo as a Codex plugin marketplace:

```bash
codex plugin marketplace add braintrustdata/braintrust-codex-plugin
# OPTIONAL: TRACE CODEX PLUGIN
codex plugin add trace-codex@braintrust-codex-plugins
# OPTIONAL: SKILLS PLUGIN
codex plugin add braintrust@braintrust-codex-plugins
```

To use the tracing plugin, create an API key in Braintrust under **Settings > API keys**. The key must be available in the environment where Codex runs. Either export it in your current shell before starting Codex:

```bash
export BRAINTRUST_API_KEY="<your-braintrust-api-key>"
TRACE_TO_BRAINTRUST=true BRAINTRUST_PROJECT=my-coding-agent codex
```

Or set it for only that Codex invocation:

```bash
BRAINTRUST_API_KEY="<your-braintrust-api-key>" TRACE_TO_BRAINTRUST=true BRAINTRUST_PROJECT=my-coding-agent codex
```

## trace codex plugin

see the plugin's [README](/plugins/trace-codex/README.md) for details and config options

## skills plugin

see the plugin's [README](/plugins/braintrust-codex-plugin/README.md) for details
