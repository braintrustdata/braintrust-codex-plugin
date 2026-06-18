# Braintrust Codex Plugins

This repo is a monorepo of Braintrust [Codex plugins](https://developers.openai.com/codex/plugins)

## Quickstart

Add this repo as a Codex plugin marketplace:

```bash
codex plugin marketplace add braintrustdata/braintrust-codex-plugin
```

Then install the plugins you want:

- mcp and skills: `codex plugin add braintrust@braintrust-codex-plugins`
- trace codex sessions to braintrust: `codex plugin add trace-codex@braintrust-codex-plugins`
    - run: `TRACE_TO_BRAINTRUST=true BRAINTRUST_PROJECT=my-coding-agent codex`
    - see plugin's [README](/plugins/trace-codex/README.md) for details and config options
