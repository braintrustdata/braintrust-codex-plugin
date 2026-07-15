import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySettingsToEnv,
  loadSettingsFile,
  type Settings,
  settingsFilePath,
} from "./settings.ts";

describe("loadSettingsFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "settings-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(content: string): string {
    const path = join(dir, "config.json");
    writeFileSync(path, content);
    return path;
  }

  test("parses recognized keys", () => {
    const path = write(
      JSON.stringify({
        apiKey: "sk-123",
        project: "proj",
        port: 40000,
        idleTimeoutMs: 1000,
      }),
    );
    expect(loadSettingsFile(path)).toEqual({
      apiKey: "sk-123",
      project: "proj",
      port: 40000,
      idleTimeoutMs: 1000,
    });
  });

  test("ignores unknown keys and a _comment", () => {
    const path = write(JSON.stringify({ _comment: "hi", nope: "x", project: "p" }));
    expect(loadSettingsFile(path)).toEqual({ project: "p" });
  });

  test("ignores empty strings and wrong types", () => {
    const path = write(JSON.stringify({ apiKey: "", project: 5, port: "nope" }));
    expect(loadSettingsFile(path)).toEqual({});
  });

  test("parses traceToBraintrust boolean and additionalMetadata object", () => {
    const path = write(
      JSON.stringify({
        traceToBraintrust: true,
        additionalMetadata: { team: "platform", n: 1 },
      }),
    );
    expect(loadSettingsFile(path)).toEqual({
      traceToBraintrust: true,
      additionalMetadata: { team: "platform", n: 1 },
    });
  });

  test("parses parentSpanId and rootSpanId", () => {
    const path = write(JSON.stringify({ parentSpanId: "parent-1", rootSpanId: "root-1" }));
    expect(loadSettingsFile(path)).toEqual({
      parentSpanId: "parent-1",
      rootSpanId: "root-1",
    });
  });

  test("ignores non-boolean traceToBraintrust and non-object/array metadata", () => {
    const path = write(JSON.stringify({ traceToBraintrust: "yes", additionalMetadata: [1, 2] }));
    expect(loadSettingsFile(path)).toEqual({});
  });

  test("parses flushOnTurnEnd boolean; ignores non-boolean", () => {
    expect(loadSettingsFile(write(JSON.stringify({ flushOnTurnEnd: true })))).toEqual({
      flushOnTurnEnd: true,
    });
    expect(loadSettingsFile(write(JSON.stringify({ flushOnTurnEnd: false })))).toEqual({
      flushOnTurnEnd: false,
    });
    expect(loadSettingsFile(write(JSON.stringify({ flushOnTurnEnd: "yes" })))).toEqual({});
  });

  test("missing file returns {}", () => {
    expect(loadSettingsFile(join(dir, "absent.json"))).toEqual({});
  });

  test("malformed JSON returns {} (never throws)", () => {
    const path = write("{ not json");
    expect(loadSettingsFile(path)).toEqual({});
  });

  test("non-object JSON returns {}", () => {
    const path = write("[1,2,3]");
    expect(loadSettingsFile(path)).toEqual({});
  });
});

describe("applySettingsToEnv", () => {
  test("applies settings to their env vars when unset", () => {
    const env: NodeJS.ProcessEnv = {};
    const settings: Settings = { apiKey: "sk-123", project: "proj", port: 40000 };
    const applied = applySettingsToEnv(settings, env);

    expect(env.BRAINTRUST_API_KEY).toBe("sk-123");
    expect(env.BRAINTRUST_PROJECT).toBe("proj");
    expect(env.BRAINTRUST_EVENT_SERVER_PORT).toBe("40000");
    expect(applied.sort()).toEqual(["apiKey", "port", "project"]);
  });

  test("environment wins: does not overwrite an existing env var", () => {
    const env: NodeJS.ProcessEnv = { BRAINTRUST_PROJECT: "from-env" };
    const applied = applySettingsToEnv({ project: "from-file", apiKey: "sk" }, env);

    expect(env.BRAINTRUST_PROJECT).toBe("from-env");
    expect(env.BRAINTRUST_API_KEY).toBe("sk");
    expect(applied).toEqual(["apiKey"]);
  });

  test("returns key names only (no values, so secrets are not exposed)", () => {
    const env: NodeJS.ProcessEnv = {};
    const applied = applySettingsToEnv({ apiKey: "super-secret" }, env);
    expect(applied).toEqual(["apiKey"]);
    expect(JSON.stringify(applied)).not.toContain("super-secret");
  });

  test("empty settings apply nothing", () => {
    const env: NodeJS.ProcessEnv = { EXISTING: "1" };
    expect(applySettingsToEnv({}, env)).toEqual([]);
    expect(env).toEqual({ EXISTING: "1" });
  });

  test("serializes booleans and objects to env strings", () => {
    const env: NodeJS.ProcessEnv = {};
    applySettingsToEnv({ traceToBraintrust: true, additionalMetadata: { team: "platform" } }, env);
    expect(env.TRACE_TO_BRAINTRUST).toBe("true");
    expect(env.BRAINTRUST_ADDITIONAL_METADATA).toBe('{"team":"platform"}');
  });

  test("maps flushOnTurnEnd to BRAINTRUST_FLUSH_ON_TURN_END", () => {
    const env: NodeJS.ProcessEnv = {};
    const applied = applySettingsToEnv({ flushOnTurnEnd: true }, env);
    expect(env.BRAINTRUST_FLUSH_ON_TURN_END).toBe("true");
    expect(applied).toEqual(["flushOnTurnEnd"]);
  });

  test("maps parentSpanId/rootSpanId to CODEX env vars", () => {
    const env: NodeJS.ProcessEnv = {};
    const applied = applySettingsToEnv({ parentSpanId: "parent-1", rootSpanId: "root-1" }, env);
    expect(env.CODEX_PARENT_SPAN_ID).toBe("parent-1");
    expect(env.CODEX_ROOT_SPAN_ID).toBe("root-1");
    expect(applied).toEqual(["parentSpanId", "rootSpanId"]);
  });
});

describe("settingsFilePath", () => {
  test("resolves config.json under PLUGIN_DATA", () => {
    expect(settingsFilePath({ PLUGIN_DATA: "/data" })).toBe("/data/config.json");
  });

  test("prefers the explicit log dir override", () => {
    expect(settingsFilePath({ BRAINTRUST_EVENT_SERVER_LOG_DIR: "/a", PLUGIN_DATA: "/b" })).toBe(
      "/a/config.json",
    );
  });

  test("falls back to a temp dir when neither is set", () => {
    expect(settingsFilePath({ TMPDIR: "/tmp/x/" })).toBe(
      "/tmp/x/braintrust-event-server/config.json",
    );
  });
});
