import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestLogger } from "../../test-helpers.ts";
import { SnapshotStore } from "./snapshot-store.ts";
import type { CodexSnapshot } from "./state-snapshot.ts";

function makeSnapshot(sessionId: string): CodexSnapshot {
  return {
    pluginVersion: "9.9.9",
    schemaVersion: 1,
    sessionId,
    savedAt: Date.now(),
    reportingConfig: { project: "p", traceToBraintrust: true },
    rootSpan: { spanId: "r", rootSpanId: "r", spanParents: [] },
    rootEnded: false,
    rootEndTime: undefined,
    rootEnrichment: { source: "startup" },
    mainScopePath: "/t.jsonl",
    scopes: [],
    compactionTriggerByTurn: [],
  };
}

describe("SnapshotStore", () => {
  let dir: string;
  let store: SnapshotStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snap-store-"));
    store = new SnapshotStore(createTestLogger(), { dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("read returns null when no snapshot exists", () => {
    expect(store.read("missing")).toBeNull();
  });

  test("write then read round-trips a snapshot", () => {
    const snap = makeSnapshot("sess-1");
    store.write("sess-1", snap);
    const loaded = store.read("sess-1");
    expect(loaded).toEqual(snap);
  });

  test("write is isolated per session id", () => {
    store.write("a", makeSnapshot("a"));
    store.write("b", makeSnapshot("b"));
    expect(store.read("a")?.sessionId).toBe("a");
    expect(store.read("b")?.sessionId).toBe("b");
  });

  test("delete removes a snapshot", () => {
    store.write("sess-1", makeSnapshot("sess-1"));
    store.delete("sess-1");
    expect(store.read("sess-1")).toBeNull();
  });

  test("delete of a missing snapshot does not throw", () => {
    expect(() => store.delete("nope")).not.toThrow();
  });

  test("read of a malformed snapshot file returns null (never throws)", () => {
    store.write("bad", makeSnapshot("bad"));
    // Corrupt the file on disk.
    writeFileSync(join(dir, "state", "bad.json"), "{ not json");
    expect(store.read("bad")).toBeNull();
  });

  test("a session id with path separators can't escape the state dir", () => {
    const evil = "../../escape";
    store.write(evil, makeSnapshot(evil));
    // It round-trips by the same (sanitized) key...
    expect(store.read(evil)?.sessionId).toBe(evil);
    // ...and never created anything outside the state dir.
    expect(() => rmSync(join(dir, "state"), { recursive: true })).not.toThrow();
  });

  test("gcOlderThan removes snapshots older than the ttl but keeps fresh ones", () => {
    store.write("old", makeSnapshot("old"));
    store.write("fresh", makeSnapshot("fresh"));
    // Backdate "old" two hours.
    const oldPath = join(dir, "state", "old.json");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(oldPath, twoHoursAgo, twoHoursAgo);

    store.gcOlderThan(60 * 60 * 1000); // 1 hour ttl

    expect(store.read("old")).toBeNull();
    expect(store.read("fresh")?.sessionId).toBe("fresh");
  });

  test("gcOlderThan on a non-existent state dir does not throw", () => {
    const empty = new SnapshotStore(createTestLogger(), {
      dir: join(dir, "does-not-exist"),
    });
    expect(() => empty.gcOlderThan()).not.toThrow();
  });
});
