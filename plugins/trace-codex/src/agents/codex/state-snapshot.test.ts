import { describe, expect, test } from "vitest";
import {
  type CodexSnapshot,
  isCompatibleSnapshot,
  redactReportingConfig,
  SNAPSHOT_SCHEMA_VERSION,
} from "./state-snapshot.ts";

function snapshot(overrides: Partial<CodexSnapshot> = {}): CodexSnapshot {
  return {
    pluginVersion: "1.2.3",
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sessionId: "s",
    savedAt: 0,
    reportingConfig: undefined,
    rootSpan: null,
    rootEnded: false,
    rootEndTime: undefined,
    rootEnrichment: {},
    mainScopePath: null,
    scopes: [],
    compactionTriggerByTurn: [],
    ...overrides,
  };
}

describe("isCompatibleSnapshot", () => {
  test("accepts a matching plugin + schema version", () => {
    expect(isCompatibleSnapshot(snapshot(), "1.2.3")).toBe(true);
  });

  test("rejects a mismatched plugin version", () => {
    expect(isCompatibleSnapshot(snapshot({ pluginVersion: "9.9.9" }), "1.2.3")).toBe(false);
  });

  test("rejects a mismatched schema version", () => {
    expect(
      isCompatibleSnapshot(snapshot({ schemaVersion: SNAPSHOT_SCHEMA_VERSION + 1 }), "1.2.3"),
    ).toBe(false);
  });
});

describe("redactReportingConfig", () => {
  test("strips the apiKey but keeps everything else", () => {
    const redacted = redactReportingConfig({
      project: "p",
      apiKey: "sk-secret",
      apiUrl: "https://api",
      traceToBraintrust: true,
    });
    expect(redacted).toEqual({
      project: "p",
      apiUrl: "https://api",
      traceToBraintrust: true,
    });
    expect("apiKey" in (redacted ?? {})).toBe(false);
  });

  test("returns undefined for an undefined config", () => {
    expect(redactReportingConfig(undefined)).toBeUndefined();
  });
});
