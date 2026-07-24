import { describe, expect, test } from "vitest";
import { parseTranscriptLine } from "./transcript.ts";

describe("parseTranscriptLine", () => {
  test("parses a well-formed record envelope", () => {
    const line = JSON.stringify({
      timestamp: "2026-06-22T04:50:25.725Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: "hi" },
    });
    const record = parseTranscriptLine(line);
    expect(record).not.toBeNull();
    expect(record?.type).toBe("response_item");
    expect(record?.payload?.type).toBe("message");
    expect(record?.timestamp).toBe("2026-06-22T04:50:25.725Z");
  });

  test("preserves unknown record types (forward compatible)", () => {
    const line = JSON.stringify({ type: "some_future_type", payload: { type: "whatever" } });
    const record = parseTranscriptLine(line);
    expect(record?.type).toBe("some_future_type");
    expect(record?.payload?.type).toBe("whatever");
  });

  test("preserves extra top-level fields", () => {
    const line = JSON.stringify({ type: "compacted", payload: {}, window_id: 42 });
    const record = parseTranscriptLine(line);
    expect((record as Record<string, unknown>)?.window_id).toBe(42);
  });

  test("returns null for a blank line", () => {
    expect(parseTranscriptLine("")).toBeNull();
    expect(parseTranscriptLine("   ")).toBeNull();
  });

  test("returns null (no throw) for malformed JSON", () => {
    expect(parseTranscriptLine('{"type":"response_item"')).toBeNull();
    expect(parseTranscriptLine("not json at all")).toBeNull();
  });

  test("returns null for JSON that isn't an object", () => {
    expect(parseTranscriptLine("[1,2,3]")).toBeNull();
    expect(parseTranscriptLine("42")).toBeNull();
    expect(parseTranscriptLine('"a string"')).toBeNull();
    expect(parseTranscriptLine("null")).toBeNull();
  });
});
