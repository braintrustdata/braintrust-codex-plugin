import { defineConfig } from "vitest/config";

// Tests live next to sources as *.test.ts and import { describe, test, expect }
// from "vitest" explicitly (no globals). They run in the Node environment since
// the code targets a Node runtime.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
