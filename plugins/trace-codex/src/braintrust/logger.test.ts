import { describe, expect, test } from "vitest";
import { resolveProjectName } from "./logger.ts";

describe("resolveProjectName", () => {
  test("prefers explicit config project over env", () => {
    expect(resolveProjectName({ project: "from-config" }, { BRAINTRUST_PROJECT: "from-env" })).toBe(
      "from-config",
    );
  });

  test("prefers BRAINTRUST_PROJECT when no config project", () => {
    expect(
      resolveProjectName(undefined, {
        BRAINTRUST_PROJECT: "explicit",
        BRAINTRUST_DEFAULT_PROJECT: "default",
      }),
    ).toBe("explicit");
  });

  test("falls back to BRAINTRUST_DEFAULT_PROJECT", () => {
    expect(resolveProjectName(undefined, { BRAINTRUST_DEFAULT_PROJECT: "default" })).toBe(
      "default",
    );
  });

  test("defaults to codex when nothing is set", () => {
    expect(resolveProjectName(undefined, {})).toBe("codex");
  });
});
