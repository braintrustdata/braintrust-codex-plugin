# Braintrust

Query traces, investigate failures, manage prompts and datasets, and run
evaluations using the hosted [Braintrust MCP server](https://docs.braintrust.dev/integrations/developer-tools/mcp).
Requires a Braintrust account with access to your organization's data plane.
Tools use that account's permissions and can read or change Braintrust data.

This package contains a remote Streamable HTTP connection with OAuth Dynamic
Client Registration (DCR). The client discovers registration and authorization
endpoints. No API key, client secret, authorization header, local process, `bt`
installation, hooks, or desktop execution is required by this package.
MCP authorization is independent of optional `bt` session tracing.

Codex discovers OAuth from the server. Its package declares only the HTTP
transport and server URL because current Codex versions reject explicit OAuth
metadata in `mcp.json`. The OpenAI submission ZIP adds the documented OAuth DCR
declaration during packaging; it does not change the GitHub package. See the
[Codex compatibility issue](https://github.com/openai/codex/issues/53658) and
[OpenAI authentication fields](https://developers.openai.com/plugins/build/plugins#configure-mcp-authentication).

## GitHub marketplace

After this version is released to the generated distribution repository:

```bash
codex plugin marketplace add braintrustdata/braintrust-codex-plugin
codex plugin add braintrust@braintrust-codex-plugins
```

You can also select **Braintrust** in a supported client's marketplace browser.
Complete the client's OAuth flow, then start a new conversation. Installing
Braintrust does not install or enable the separate tracing plugin.

The GitHub package's `mcp.json` has a concrete NA URL. It does not implement
public-directory template configuration or an endpoint picker. Current Codex
plugin policy settings document enablement and tool approval, not a server URL
override. To use EU or a custom endpoint today, have your admin copy this
package into a local/team marketplace and replace only
`mcpServers.braintrust.url` in that copy's `mcp.json` with the complete URL below.
The canonical release validator intentionally pins the NA review configuration;
an organization-specific copy needs its own endpoint validation. Avoid editing
the installed cache: marketplace upgrades can replace it. Do not enable both
the NA package and a duplicate connection for the same tools.

| Data plane | MCP URL |
| --- | --- |
| NA (called US in Braintrust docs) | `https://api.braintrust.dev/mcp` |
| EU | `https://api-eu.braintrust.dev/mcp` |
| Custom / self-hosted | Copy the complete MCP URL from **Settings > Data plane**. |

Braintrust documents the custom URL as the configured API base URL with `/mcp`
appended. Preserve any deployment-specific path prefix or other supplied URL
details; do not reduce every custom URL to `https://<host>/mcp`.

## Public-directory template listing (pending external setup)

The intended public listing is one template-based Braintrust plugin for all
data planes. The package supplies a concrete NA endpoint for review and scans.
It does **not** establish NA as the installation default. Preselect/prefill NA
only if OpenAI confirms the installation UI supports it.

OpenAI describes **Example MCP Server URL** and **Template MCP Server URL** as
submission settings. The candidate template `https://{data_plane_host}/mcp`
needs OpenAI confirmation: the published example varies a subdomain, not an
arbitrary full host. That candidate also cannot represent an API base with a
path prefix. Support for those custom URL shapes and parameter defaults must
be confirmed before configuring the listing. Do not place a template URL or
invent template/default fields in `mcp.json` or `plugin.json`.

Template submissions are restricted to trusted developers with an established
OpenAI relationship. Portal access, eligibility, supported parameter shapes,
and authenticated installation evidence are still prerequisites. Portal
template settings are not automatically applied to GitHub marketplace installs.
This package has not been approved or submitted.

## Support and package assets

See [Braintrust troubleshooting](https://docs.braintrust.dev/kb/troubleshooting-guides)
or contact [support@braintrust.dev](mailto:support@braintrust.dev).
[Privacy policy](https://www.braintrust.dev/legal/privacy-policy) ·
[Terms of service](https://www.braintrust.dev/legal/terms-of-service).

`assets/icon.png` is the existing 200×200 Braintrust icon copied verbatim from
this monorepo's `src/plugins/cursor/content/icon.png`; the brand color and legal
URLs also match existing Braintrust plugin metadata. No synthetic screenshots
or invented contact details are included.
