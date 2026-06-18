# Braintrust Codex Plugins

This repo is a monorepo of Braintrust [Codex plugins](https://developers.openai.com/codex/plugins)

## Quickstart

Add this repo as a Codex plugin marketplace:

```bash
codex plugin marketplace add braintrustdata/braintrust-codex-plugin
# OPTINAL: TRACE CODEX PLUGIN
codex plugin add trace-codex@braintrust-codex-plugins
TRACE_TO_BRAINTRUST=true BRAINTRUST_PROJECT=my-coding-agent codex
# OPTIONAL: SKILLS PLUGIN
codex plugin add braintrust@braintrust-codex-plugins
```

## trace codex plugin

see the plugin's [README](/plugins/trace-codex/README.md) for details and config options

## skills plugin

see the plugin's [README](/plugins/braintrust-codex-plugin/README.md) for details
