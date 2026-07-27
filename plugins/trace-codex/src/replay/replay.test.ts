import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EventRecorder } from "../server/recorder.ts";
import type { EnqueueEvent } from "../server/routes.ts";
import { createTestLogger } from "../test-helpers.ts";
import { parseRecording } from "./replay.ts";

// A generic sample event; replay/recorder are agent-agnostic, so these tests
// don't depend on any particular agent's event shape.
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

describe("parseRecording", () => {
  test("parses newline-delimited events, skipping blank lines", () => {
    const events = [
      sampleEvent(),
      sampleEvent({ eventName: "Other", eventData: { n: 1 } }),
      sampleEvent({ queueId: "session-2" }),
    ];
    const text = `${events.map((e) => JSON.stringify(e)).join("\n")}\n\n`;
    expect(parseRecording(text)).toEqual(events);
  });

  test("skips malformed lines instead of throwing", () => {
    const good = sampleEvent();
    const text = `${JSON.stringify(good)}\nnot json\n`;
    expect(parseRecording(text, createTestLogger())).toEqual([good]);
  });

  test("returns [] for empty input", () => {
    expect(parseRecording("")).toEqual([]);
  });
});

describe("recorder -> parser round-trip", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "roundtrip-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("events written by the recorder parse back equal to the originals", () => {
    const events = [
      sampleEvent({ eventName: "Start", eventData: { model: "x" } }),
      sampleEvent({ eventName: "Prompt", eventData: { prompt: "hi" } }),
      sampleEvent({ eventName: "Stop" }),
      sampleEvent({ eventName: "Prompt", eventData: { prompt: "and another" } }),
      sampleEvent({ eventName: "Stop" }),
    ];

    const path = join(dir, "session.ndjson");
    const recorder = new EventRecorder(path, createTestLogger());
    for (const e of events) recorder.record(e);

    const parsed = parseRecording(readFileSync(path, "utf8"));
    expect(parsed).toEqual(events);
  });
});
