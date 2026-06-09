// The server reports the plugin's version on /health. We read it from the
// plugin manifest at build/bundle time so there is a single source of truth.
//
// `with { type: "json" }` import attributes let Bun inline the JSON into the
// compiled binary, so this works in the standalone executable with no runtime
// file access.
import manifest from "../.codex-plugin/plugin.json" with { type: "json" };

export const PLUGIN_VERSION: string = manifest.version;
