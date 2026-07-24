import { defineConfig } from "tsup";

// Bundle the CLI entrypoint into a single self-contained CommonJS file that the
// pkg step (scripts/build.ts) wraps into a standalone binary. Everything —
// including the `braintrust` dependency and the inlined plugin.json version — is
// bundled so the produced binary needs no node_modules at runtime.
export default defineConfig({
  entry: { "codex-hook": "src/index.ts" },
  outDir: "dist",
  format: ["cjs"],
  platform: "node",
  // pkg's base binaries; keep the language target comfortably below them.
  target: "node20",
  bundle: true,
  // Bundle dependencies too (tsup externalizes package.json `dependencies` by
  // default). This inlines `braintrust` so the produced binary is a single
  // self-contained file and pkg has nothing to trace beyond Node built-ins.
  noExternal: [/.*/],
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  minify: false,
});
