import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestLogger } from "../test-helpers.ts";
import { EventRecorder, redactForRecording } from "./recorder.ts";
import type { EnqueueEvent } from "./routes.ts";

// Generic sample events; the recorder is agent-agnostic.
function sampleEvent(overrides: Partial<EnqueueEvent> = {}): EnqueueEvent {
  return {
    queueId: "session-1",
    eventSource: "test-agent",
    eventSourceVersion: null,
    eventName: "Something",
    eventData: { foo: "bar" },
    ...overrides,
  };
}

describe("EventRecorder", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "recorder-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("records events as newline-delimited JSON that round-trips", () => {
    const file = join(dir, "session.ndjson");
    const recorder = new EventRecorder(file, createTestLogger());

    const events = [
      sampleEvent({ eventName: "Start", eventData: { model: "x" } }),
      sampleEvent({ eventName: "Prompt", eventData: { prompt: "hi" } }),
      sampleEvent({ eventName: "Stop" }),
    ];
    for (const e of events) recorder.record(e);

    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed).toEqual(events);
  });

  test("truncates an existing file on open", () => {
    const file = join(dir, "session.ndjson");
    writeFileSync(file, "stale\nlines\n");

    const recorder = new EventRecorder(file, createTestLogger());
    recorder.record(sampleEvent());

    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).eventName).toBe("Something");
  });

  test("creates the parent directory if missing", () => {
    const file = join(dir, "nested", "deep", "session.ndjson");
    const recorder = new EventRecorder(file, createTestLogger());
    recorder.record(sampleEvent());
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
  });

  test("never throws when the path is unwritable", () => {
    // A path whose parent is a file, not a directory: open will fail.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const file = join(blocker, "session.ndjson");

    const recorder = new EventRecorder(file, createTestLogger());
    // record() must be a safe no-op rather than throwing.
    expect(() => recorder.record(sampleEvent())).not.toThrow();
  });

  test("redacts the apiKey field from recorded config events", () => {
    const file = join(dir, "session.ndjson");
    const recorder = new EventRecorder(file, createTestLogger());
    recorder.record(
      sampleEvent({
        eventName: "__braintrust_config",
        eventData: { project: "p", apiKey: "sk-super-secret", apiUrl: "https://api" },
      }),
    );

    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("sk-super-secret");
    const parsed = JSON.parse(raw.trim());
    expect(parsed.eventData).toEqual({
      project: "p",
      apiKey: "__redacted__",
      apiUrl: "https://api",
    });
  });
});

describe("redactForRecording", () => {
  test("redacts apiKey but leaves other events untouched", () => {
    const withKey = sampleEvent({ eventData: { apiKey: "sk-1", project: "p" } });
    expect((redactForRecording(withKey).eventData as { apiKey: string }).apiKey).toBe(
      "__redacted__",
    );

    const noKey = sampleEvent({ eventData: { foo: "bar" } });
    // No secret fields: returns the same event unchanged.
    expect(redactForRecording(noKey)).toBe(noKey);
  });

  test("does not mutate the original event", () => {
    const ev = sampleEvent({ eventData: { apiKey: "sk-1" } });
    redactForRecording(ev);
    expect((ev.eventData as { apiKey: string }).apiKey).toBe("sk-1");
  });

  test("tolerates non-object eventData", () => {
    const ev = sampleEvent({ eventData: "raw string" });
    expect(redactForRecording(ev)).toBe(ev);
  });
});
