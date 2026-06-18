import { describe, expect, test } from "bun:test";
import type { ReportingConfig, SpanFactory } from "../../braintrust/logger.ts";
import type { EnqueueEvent } from "../../server/routes.ts";
import { createTestLogger, withCapturedTrace } from "../../test-helpers.ts";
import { CODEX_CONFIG_EVENT } from "./event-builder.ts";
import { CodexEventProcessor } from "./event-processor.ts";
import {
  assertProducesTrace,
  configEvent,
  sessionStart,
  stop,
  userPromptSubmit,
} from "./test-helpers.ts";

describe("CodexEventProcessor", () => {
  test("SessionStart produces a root span", async () => {
    await assertProducesTrace(
      [sessionStart({ model: "gpt-5.5", cwd: "/work", source: "startup" })],
      {
        span_attributes: { name: "codex: work", type: "task" },
        input: { model: "gpt-5.5", cwd: "/work", source: "startup" },
        metadata: { session_id: "session-1", model: "gpt-5.5" },
        children: [],
      },
    );
  });

  test("root span is named after the project directory (basename of cwd)", async () => {
    await assertProducesTrace([sessionStart({ cwd: "/whatever/myapp" })], {
      span_attributes: { name: "codex: myapp", type: "task" },
      children: [],
    });
  });

  test("root span name handles a trailing slash in cwd", async () => {
    await assertProducesTrace([sessionStart({ cwd: "/whatever/myapp/" })], {
      span_attributes: { name: "codex: myapp", type: "task" },
      children: [],
    });
  });

  test("root span falls back to 'codex session' when cwd is missing", async () => {
    await assertProducesTrace([sessionStart({})], {
      span_attributes: { name: "codex session", type: "task" },
      children: [],
    });
  });

  test("a session with no Stop stays active (no end time)", async () => {
    await assertProducesTrace(
      [sessionStart({ model: "gpt-5.5", source: "startup" }), userPromptSubmit({ prompt: "hi" })],
      {
        span_attributes: { name: "codex session", type: "task" },
        ended: false,
        children: [],
      },
    );
  });

  test("Stop ends the root span", async () => {
    await assertProducesTrace(
      [
        sessionStart({ model: "gpt-5.5", source: "startup" }),
        userPromptSubmit({ prompt: "hi" }),
        stop({}),
      ],
      {
        span_attributes: { name: "codex session", type: "task" },
        ended: true,
        children: [],
      },
    );
  });

  test("ends on the first Stop; later events do not reopen it", async () => {
    await assertProducesTrace(
      [
        sessionStart({ model: "gpt-5.5", source: "startup" }),
        userPromptSubmit({ prompt: "hi", turn_id: "t1" }),
        stop({ turn_id: "t1", last_assistant_message: "hello" }),
        userPromptSubmit({ prompt: "another thing", turn_id: "t2" }),
        stop({ turn_id: "t2", last_assistant_message: "ok" }),
      ],
      {
        span_attributes: { name: "codex session", type: "task" },
        ended: true,
        children: [
          { span_attributes: { name: "turn: t1", type: "task" } },
          { span_attributes: { name: "turn: t2", type: "task" } },
        ],
      },
    );
  });

  test("a turn becomes a child span with prompt input and assistant output", async () => {
    await assertProducesTrace(
      [
        sessionStart({ model: "gpt-5.5", source: "startup" }),
        userPromptSubmit({ prompt: "what's your name?", turn_id: "t1" }),
        stop({ turn_id: "t1", last_assistant_message: "I'm Codex." }),
      ],
      {
        span_attributes: { name: "codex session", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            input: "what's your name?",
            output: "I'm Codex.",
            metadata: { turn_id: "t1" },
            ended: true,
          },
        ],
      },
    );
  });

  test("an open turn with no matching Stop stays active", async () => {
    await assertProducesTrace(
      [
        sessionStart({ model: "gpt-5.5", source: "startup" }),
        userPromptSubmit({ prompt: "hi", turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex session", type: "task" },
        ended: false,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            input: "hi",
            ended: false,
          },
        ],
      },
    );
  });

  test("a Stop with no matching turn does not create a turn span", async () => {
    await assertProducesTrace(
      [
        sessionStart({ model: "gpt-5.5", source: "startup" }),
        stop({ turn_id: "nope", last_assistant_message: "orphan" }),
      ],
      {
        span_attributes: { name: "codex session", type: "task" },
        ended: true,
        children: [],
      },
    );
  });

  test("duplicate SessionStart still yields a single root span", async () => {
    await assertProducesTrace(
      [
        sessionStart({ model: "gpt-5.5", source: "startup" }),
        sessionStart({ model: "gpt-5.5", source: "startup" }),
      ],
      {
        span_attributes: { name: "codex session", type: "task" },
        children: [],
      },
    );
  });

  test("a config event builds the per-session factory with its config", () => {
    // Spy provider records the config it was asked to build a factory for.
    let seen: ReportingConfig | undefined;
    const fake: SpanFactory = {
      startSpan: () =>
        ({ id: "s", end: () => 0, log: () => {} }) as unknown as ReturnType<
          SpanFactory["startSpan"]
        >,
      flush: async () => {},
    };
    const provider = (config?: ReportingConfig) => {
      seen = config;
      return fake;
    };

    const processor = new CodexEventProcessor("sess-1", createTestLogger(), provider);
    const cfg: EnqueueEvent = {
      queueId: "sess-1",
      eventSource: "codex-hook",
      eventSourceVersion: null,
      eventName: CODEX_CONFIG_EVENT,
      eventData: {
        project: "team-project",
        apiKey: "sk-1",
        apiUrl: "https://api",
        traceToBraintrust: true,
      },
    };
    processor.process(cfg);
    // Factory is built lazily on first span (the SessionStart).
    processor.process(sessionStart({ session_id: "sess-1", model: "gpt-5.5" }));

    expect(seen).toEqual({
      project: "team-project",
      apiKey: "sk-1",
      apiUrl: "https://api",
      appUrl: undefined,
      traceToBraintrust: true,
      additionalMetadata: undefined,
    });
  });

  test("root span metadata carries the configured project", async () => {
    await assertProducesTrace(
      [configEvent({ project: "team-project" }), sessionStart({ model: "gpt-5.5" })],
      {
        span_attributes: { name: "codex session", type: "task" },
        metadata: { project: "team-project" },
        children: [],
      },
    );
  });

  test("when tracing is disabled, no spans are produced", async () => {
    const trace = withCapturedTrace();
    try {
      const processor = new CodexEventProcessor("s", createTestLogger(), () => trace.spanFactory);
      // Config event WITHOUT traceToBraintrust (defaults off).
      processor.process({
        queueId: "s",
        eventSource: "codex-hook",
        eventSourceVersion: null,
        eventName: CODEX_CONFIG_EVENT,
        eventData: { project: "p" },
      });
      processor.process(sessionStart({ session_id: "s" }));
      processor.process(userPromptSubmit({ session_id: "s", turn_id: "t1", prompt: "hi" }));
      processor.process(stop({ session_id: "s", turn_id: "t1", last_assistant_message: "yo" }));
      await processor.flush();

      const spans = await trace.drain();
      expect(spans.length).toBe(0);
    } finally {
      trace.cleanup();
    }
  });

  test("additionalMetadata is merged into root metadata; standard keys win", async () => {
    await assertProducesTrace(
      [
        configEvent({
          project: "team-project",
          additionalMetadata: { team: "platform", model: "SHOULD_BE_OVERRIDDEN" },
        }),
        sessionStart({ model: "gpt-5.5" }),
      ],
      {
        span_attributes: { name: "codex session", type: "task" },
        // team comes from additionalMetadata; model is the standard key (wins).
        metadata: { team: "platform", model: "gpt-5.5", project: "team-project" },
        children: [],
      },
    );
  });
});
