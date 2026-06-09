import { describe, expect, test } from "bun:test";
import {
  buildConfigEvent,
  buildEnqueueEvents,
  CODEX_CONFIG_EVENT,
  resolveReportingConfig,
} from "./event-builder.ts";

describe("buildEnqueueEvents", () => {
  test("a non-SessionStart event yields a single event", () => {
    const events = buildEnqueueEvents(
      '{"hook_event_name":"UserPromptSubmit","session_id":"sess-123","x":1}',
      {},
    );
    expect(events.length).toBe(1);
    const e = events[0];
    expect(e.queueId).toBe("sess-123");
    expect(e.eventSource).toBe("codex-hook");
    expect(e.eventName).toBe("UserPromptSubmit");
    expect(e.eventData).toEqual({
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-123",
      x: 1,
    });
  });

  test("SessionStart yields a leading config event with the same queueId", () => {
    const events = buildEnqueueEvents('{"hook_event_name":"SessionStart","session_id":"s1"}', {
      BRAINTRUST_PROJECT: "proj",
    });
    expect(events.length).toBe(2);
    const [config, start] = events;
    expect(config.eventName).toBe(CODEX_CONFIG_EVENT);
    expect(config.queueId).toBe("s1");
    expect((config.eventData as { project?: string }).project).toBe("proj");
    expect(start.eventName).toBe("SessionStart");
    expect(start.queueId).toBe("s1");
  });

  test("null queueId when session_id is missing", () => {
    const events = buildEnqueueEvents('{"hook_event_name":"Stop"}', {});
    expect(events.length).toBe(1);
    expect(events[0].queueId).toBeNull();
    expect(events[0].eventName).toBe("Stop");
  });

  test("null queueId when session_id is empty", () => {
    const [e] = buildEnqueueEvents('{"hook_event_name":"Stop","session_id":""}', {});
    expect(e.queueId).toBeNull();
  });

  test("forwards raw text and null queueId on non-JSON stdin", () => {
    const [e] = buildEnqueueEvents("not json at all", {});
    expect(e.queueId).toBeNull();
    expect(e.eventName).toBe("unknown");
    expect(e.eventData).toEqual({ raw: "not json at all" });
  });

  test("uses CODEX_VERSION env when present", () => {
    const [e] = buildEnqueueEvents('{"hook_event_name":"Stop","session_id":"s"}', {
      CODEX_VERSION: "1.2.3",
    });
    expect(e.eventSourceVersion).toBe("1.2.3");
  });

  test("null version when env missing", () => {
    const [e] = buildEnqueueEvents('{"hook_event_name":"Stop","session_id":"s"}', {});
    expect(e.eventSourceVersion).toBeNull();
  });

  test("defaults event name to unknown when hook_event_name missing", () => {
    const [e] = buildEnqueueEvents('{"session_id":"abc"}', {});
    expect(e.eventName).toBe("unknown");
  });
});

describe("resolveReportingConfig", () => {
  test("reads project/key/urls from env", () => {
    expect(
      resolveReportingConfig({
        BRAINTRUST_PROJECT: "p",
        BRAINTRUST_API_KEY: "sk-1",
        BRAINTRUST_API_URL: "https://api",
        BRAINTRUST_APP_URL: "https://app",
      }),
    ).toEqual({
      project: "p",
      apiKey: "sk-1",
      apiUrl: "https://api",
      appUrl: "https://app",
      traceToBraintrust: false,
    });
  });

  test("falls back to BRAINTRUST_DEFAULT_PROJECT for project", () => {
    expect(resolveReportingConfig({ BRAINTRUST_DEFAULT_PROJECT: "dp" })).toEqual({
      project: "dp",
      traceToBraintrust: false,
    });
  });

  test("empty env yields traceToBraintrust:false and nothing else", () => {
    expect(resolveReportingConfig({})).toEqual({ traceToBraintrust: false });
  });

  test("TRACE_TO_BRAINTRUST true/1 enables tracing; other values disable", () => {
    expect(resolveReportingConfig({ TRACE_TO_BRAINTRUST: "true" }).traceToBraintrust).toBe(true);
    expect(resolveReportingConfig({ TRACE_TO_BRAINTRUST: "1" }).traceToBraintrust).toBe(true);
    expect(resolveReportingConfig({ TRACE_TO_BRAINTRUST: "TRUE" }).traceToBraintrust).toBe(true);
    expect(resolveReportingConfig({ TRACE_TO_BRAINTRUST: "false" }).traceToBraintrust).toBe(false);
    expect(resolveReportingConfig({ TRACE_TO_BRAINTRUST: "no" }).traceToBraintrust).toBe(false);
  });

  test("parses BRAINTRUST_ADDITIONAL_METADATA JSON object", () => {
    expect(
      resolveReportingConfig({ BRAINTRUST_ADDITIONAL_METADATA: '{"team":"platform","n":1}' })
        .additionalMetadata,
    ).toEqual({ team: "platform", n: 1 });
  });

  test("ignores malformed or non-object additional metadata", () => {
    expect(
      resolveReportingConfig({ BRAINTRUST_ADDITIONAL_METADATA: "not json" }).additionalMetadata,
    ).toBeUndefined();
    expect(
      resolveReportingConfig({ BRAINTRUST_ADDITIONAL_METADATA: "[1,2]" }).additionalMetadata,
    ).toBeUndefined();
  });
});

describe("buildConfigEvent", () => {
  test("carries the reporting config (including apiKey) on the wire", () => {
    const e = buildConfigEvent("s1", {
      BRAINTRUST_PROJECT: "p",
      BRAINTRUST_API_KEY: "sk-secret",
      TRACE_TO_BRAINTRUST: "true",
    });
    expect(e.eventName).toBe(CODEX_CONFIG_EVENT);
    expect(e.queueId).toBe("s1");
    expect(e.eventData).toEqual({ project: "p", apiKey: "sk-secret", traceToBraintrust: true });
  });
});
