import { describe, expect, test } from "bun:test";
import type { ReportingConfig, SpanFactory } from "../../braintrust/logger.ts";
import type { EnqueueEvent } from "../../server/routes.ts";
import { createTestLogger, spansToTree, withCapturedTrace } from "../../test-helpers.ts";
import { CODEX_CONFIG_EVENT } from "./event-builder.ts";
import { CodexEventProcessor } from "./event-processor.ts";
import {
  assertProducesTrace,
  assistantMessage,
  configEvent,
  customToolCall,
  customToolCallOutput,
  FakeTranscriptReader,
  functionCall,
  functionCallOutput,
  reasoning,
  sessionMeta,
  sessionStart,
  stop,
  taskComplete,
  taskStarted,
  tokenCount,
  transcript,
  turnContext,
  userMessage,
  userMessageItem,
} from "./test-helpers.ts";
import type {
  TranscriptReader,
  TranscriptReadResult,
  TranscriptWaitResult,
  WaitForOptions,
} from "./transcript-reader.ts";

// Helpers below build a session as an ordered list of transcript writes and
// hooks. The final `stop()` hook triggers the catch-up that turns the buffered
// transcript records into spans (waiting for the task_complete sentinel).

describe("CodexEventProcessor: root span", () => {
  test("session_meta opens a root span named after the cwd basename", async () => {
    await assertProducesTrace(
      [
        sessionStart({ source: "startup" }),
        sessionMeta({ cwd: "/whatever/myapp", id: "session-1" }),
        turnContext({ model: "gpt-5.5" }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: myapp", type: "task" },
        metadata: { session_id: "session-1", model: "gpt-5.5", source: "startup" },
        children: [],
      },
    );
  });

  test("root span name handles a trailing slash in cwd", async () => {
    await assertProducesTrace(
      [sessionStart(), sessionMeta({ cwd: "/whatever/myapp/" }), stop({ turn_id: "t1" })],
      { span_attributes: { name: "codex: myapp", type: "task" }, children: [] },
    );
  });

  test("root span falls back to 'codex session' when cwd is missing", async () => {
    await assertProducesTrace([sessionStart(), sessionMeta({}), stop({ turn_id: "t1" })], {
      span_attributes: { name: "codex session", type: "task" },
      children: [],
    });
  });

  test("model is backfilled from turn_context", async () => {
    await assertProducesTrace(
      [sessionStart(), sessionMeta({ cwd: "/work" }), turnContext({ model: "gpt-5.5" }), stop({})],
      {
        span_attributes: { name: "codex: work", type: "task" },
        metadata: { model: "gpt-5.5" },
        children: [],
      },
    );
  });

  test("root carries source and permission_mode from the SessionStart hook", async () => {
    await assertProducesTrace(
      [
        sessionStart({ source: "resume", permission_mode: "acceptEdits" }),
        sessionMeta({ cwd: "/work" }),
        stop({}),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        metadata: { source: "resume", permission_mode: "acceptEdits" },
        children: [],
      },
    );
  });

  test("duplicate session_meta still yields a single root span", async () => {
    await assertProducesTrace(
      [sessionStart(), sessionMeta({ cwd: "/work" }), sessionMeta({ cwd: "/work" }), stop({})],
      { span_attributes: { name: "codex: work", type: "task" }, children: [] },
    );
  });

  test("Stop ends the root span", async () => {
    await assertProducesTrace([sessionStart(), sessionMeta({ cwd: "/work" }), stop({})], {
      span_attributes: { name: "codex: work", type: "task" },
      ended: true,
      children: [],
    });
  });
});

describe("CodexEventProcessor: turn spans", () => {
  test("task_started/task_complete become a turn span with prompt input and assistant output", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        turnContext({ model: "gpt-5.5" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "what's your name?" }),
        taskComplete({ turn_id: "t1", last_agent_message: "I'm Codex." }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            input: "what's your name?",
            output: "I'm Codex.",
            metadata: { turn_id: "t1" },
            ended: true,
            children: [],
          },
        ],
      },
    );
  });

  test("two turns become two ordered child spans", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "one" }),
        taskComplete({ turn_id: "t1", last_agent_message: "first" }),
        taskStarted({ turn_id: "t2" }),
        userMessage({ message: "two" }),
        taskComplete({ turn_id: "t2", last_agent_message: "second" }),
        stop({ turn_id: "t2" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          { span_attributes: { name: "turn: t1", type: "task" }, output: "first", ended: true },
          { span_attributes: { name: "turn: t2", type: "task" }, output: "second", ended: true },
        ],
      },
    );
  });

  test("a turn whose task_complete lands after its Stop is closed by the final flush catch-up", async () => {
    // Regression: the last turn's task_complete can be written just after its
    // Stop hook fires, so the Stop's bounded wait misses it. The final flush
    // read must still pick it up and close the turn. Here task_complete is
    // ordered AFTER stop() in the list (so it is only present at flush time).
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "one" }),
        taskComplete({ turn_id: "t1", last_agent_message: "first" }),
        stop({ turn_id: "t1" }),
        taskStarted({ turn_id: "t2" }),
        userMessage({ message: "two" }),
        // Tool call/output present at Stop time, but task_complete is not yet.
        functionCall({ turn_id: "t2", name: "exec_command", call_id: "c2" }),
        functionCallOutput({ call_id: "c2", output: "ok" }),
        stop({ turn_id: "t2" }),
        // task_complete written after the Stop — only seen by the flush catch-up.
        taskComplete({ turn_id: "t2", last_agent_message: "second" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          { span_attributes: { name: "turn: t1", type: "task" }, output: "first", ended: true },
          {
            span_attributes: { name: "turn: t2", type: "task" },
            output: "second",
            ended: true,
            children: [{ span_attributes: { name: "exec_command", type: "tool" }, ended: true }],
          },
        ],
      },
    );
  });

  test("each turn closes when its own Stop arrives (per-turn Stops)", async () => {
    // Mirrors real Codex: Stop fires per turn. Turn 1 is processed/closed on its
    // own Stop; turn 2 opens after and closes on the second Stop. Regression for
    // the bug where the second turn never closed.
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "one" }),
        taskComplete({ turn_id: "t1", last_agent_message: "first" }),
        stop({ turn_id: "t1" }),
        taskStarted({ turn_id: "t2" }),
        userMessage({ message: "two" }),
        taskComplete({ turn_id: "t2", last_agent_message: "second" }),
        stop({ turn_id: "t2" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          { span_attributes: { name: "turn: t1", type: "task" }, output: "first", ended: true },
          { span_attributes: { name: "turn: t2", type: "task" }, output: "second", ended: true },
        ],
      },
    );
  });

  test("a turn still open when the root ends is closed by the root-end backstop", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "hi" }),
        // No task_complete; the Stop hook ends the root and closes the turn.
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          { span_attributes: { name: "turn: t1", type: "task" }, input: "hi", ended: true },
        ],
      },
    );
  });
});

describe("CodexEventProcessor: span timing (from transcript timestamps)", () => {
  // :10Z=1767225610, :11=...611, :12=...612, :13=...613, :14=...614, :15=...615.
  test("llm and tool spans use their own transcript record timestamps", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        transcript({
          type: "session_meta",
          timestamp: "2026-01-01T00:00:10Z",
          payload: { cwd: "/work", id: "session-1" },
        }),
        transcript({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:11Z",
          payload: { type: "task_started", turn_id: "t1" },
        }),
        // LLM call: opens at the assistant message (:12), requests a tool (:13),
        // result arrives (:14), and the call closes at token_count (:15).
        transcript({
          type: "response_item",
          timestamp: "2026-01-01T00:00:12Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "go" }],
          },
        }),
        transcript({
          type: "response_item",
          timestamp: "2026-01-01T00:00:13Z",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "c1",
            metadata: { turn_id: "t1" },
          },
        }),
        transcript({
          type: "response_item",
          timestamp: "2026-01-01T00:00:14Z",
          payload: { type: "function_call_output", call_id: "c1", output: "ok" },
        }),
        transcript({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:15Z",
          payload: { type: "token_count", info: { last_token_usage: { total_tokens: 5 } } },
        }),
        transcript({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:16Z",
          payload: { type: "task_complete", turn_id: "t1", last_agent_message: "done" },
        }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        metrics: { start: 1767225610, end: 1767225616 },
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            metrics: { start: 1767225611, end: 1767225616 },
            ended: true,
            children: [
              {
                // LLM call: opened at the message (:12), closed at token_count (:15).
                span_attributes: { name: "llm", type: "llm" },
                metrics: { start: 1767225612, end: 1767225615 },
                ended: true,
              },
              {
                // Tool span uses its own record timestamps: function_call (:13)
                // to function_call_output (:14). Ordered after the llm by start.
                span_attributes: { name: "exec_command", type: "tool" },
                metrics: { start: 1767225613, end: 1767225614 },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });
});

describe("CodexEventProcessor: tool spans", () => {
  test("a function_call/output pair becomes a tool span under its turn", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "run it" }),
        functionCall({
          turn_id: "t1",
          name: "exec_command",
          call_id: "call_1",
          arguments: '{"cmd":"ls"}',
        }),
        functionCallOutput({ call_id: "call_1", output: "file.txt" }),
        taskComplete({ turn_id: "t1", last_agent_message: "done" }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            output: "done",
            ended: true,
            children: [
              {
                span_attributes: { name: "exec_command", type: "tool" },
                input: '{"cmd":"ls"}',
                output: "file.txt",
                metadata: { tool_name: "exec_command", call_id: "call_1", turn_id: "t1" },
                ended: true,
                children: [],
              },
            ],
          },
        ],
      },
    );
  });

  test("custom_tool_call (apply_patch) becomes a tool span using the raw name", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        customToolCall({
          turn_id: "t1",
          name: "apply_patch",
          call_id: "call_2",
          input: "*** Begin Patch",
        }),
        customToolCallOutput({ call_id: "call_2", output: "Success" }),
        taskComplete({ turn_id: "t1", last_agent_message: "ok" }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            ended: true,
            children: [
              {
                span_attributes: { name: "apply_patch", type: "tool" },
                input: "*** Begin Patch",
                output: "Success",
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  test("multiple tool calls in one turn become ordered sibling tool spans", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        functionCall({ turn_id: "t1", name: "exec_command", call_id: "c1" }),
        functionCallOutput({ call_id: "c1", output: "a" }),
        customToolCall({ turn_id: "t1", name: "apply_patch", call_id: "c2" }),
        customToolCallOutput({ call_id: "c2", output: "b" }),
        taskComplete({ turn_id: "t1", last_agent_message: "done" }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            ended: true,
            children: [
              { span_attributes: { name: "exec_command", type: "tool" }, output: "a", ended: true },
              { span_attributes: { name: "apply_patch", type: "tool" }, output: "b", ended: true },
            ],
          },
        ],
      },
    );
  });

  test("an unpaired tool call (no output) is closed when its turn ends", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        functionCall({ turn_id: "t1", name: "exec_command", call_id: "c1", arguments: "{}" }),
        // No output for c1; the turn completes anyway.
        taskComplete({ turn_id: "t1", last_agent_message: "done" }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            ended: true,
            children: [
              {
                span_attributes: { name: "exec_command", type: "tool" },
                input: "{}",
                ended: true,
                children: [],
              },
            ],
          },
        ],
      },
    );
  });

  test("a tool call with no matching open turn span is skipped", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        // turn_id "tX" was never opened; the tool span must be skipped.
        functionCall({ turn_id: "tX", name: "exec_command", call_id: "c1" }),
        functionCallOutput({ call_id: "c1", output: "x" }),
        taskComplete({ turn_id: "t1", last_agent_message: "done" }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          { span_attributes: { name: "turn: t1", type: "task" }, ended: true, children: [] },
        ],
      },
    );
  });
});

describe("CodexEventProcessor: llm spans", () => {
  test("a model call becomes an llm span (output + token metrics) under its turn", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        turnContext({ model: "gpt-5.5" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "yo!" }),
        reasoning(),
        assistantMessage("Hey. What are we working on?"),
        tokenCount({ input_tokens: 100, output_tokens: 14, total_tokens: 114 }),
        taskComplete({ turn_id: "t1", last_agent_message: "Hey. What are we working on?" }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            ended: true,
            children: [
              {
                span_attributes: { name: "gpt-5.5", type: "llm" },
                output: { role: "assistant", content: "Hey. What are we working on?" },
                // Codex token keys mapped to Braintrust standard metric names.
                metrics: { prompt_tokens: 100, completion_tokens: 14, tokens: 114 },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  test("llm input is reconstructed from prior conversation messages", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        turnContext({ model: "gpt-5.5" }),
        taskStarted({ turn_id: "t1" }),
        // The prompt arrives as a response_item user message (history source).
        userMessageItem("yo!"),
        assistantMessage("Hey."),
        tokenCount({ input_tokens: 10, output_tokens: 2, total_tokens: 12 }),
        taskComplete({ turn_id: "t1", last_agent_message: "Hey." }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            children: [
              {
                span_attributes: { name: "gpt-5.5", type: "llm" },
                // Input = the user prompt seen before the call opened (chat msgs).
                input: [{ role: "user", content: "yo!" }],
                output: { role: "assistant", content: "Hey." },
              },
            ],
          },
        ],
      },
    );
  });

  test("multiple model calls interleave with tool spans in execution order", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        turnContext({ model: "gpt-5.5" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "do it" }),
        // First model call: asks for a tool.
        assistantMessage("calling tool"),
        functionCall({ turn_id: "t1", name: "exec_command", call_id: "c1" }),
        tokenCount({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }),
        functionCallOutput({ call_id: "c1", output: "result" }),
        // Second model call: final answer.
        assistantMessage("done"),
        tokenCount({ input_tokens: 20, output_tokens: 3, total_tokens: 23 }),
        taskComplete({ turn_id: "t1", last_agent_message: "done" }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            ended: true,
            // Ordered siblings: llm(call 1), tool, llm(call 2).
            children: [
              {
                span_attributes: { name: "gpt-5.5", type: "llm" },
                // The call produced an assistant message plus a tool call.
                output: [
                  { role: "assistant", content: "calling tool" },
                  {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "c1",
                        type: "function",
                        function: { name: "exec_command", arguments: "{}" },
                      },
                    ],
                  },
                ],
                ended: true,
              },
              { span_attributes: { name: "exec_command", type: "tool" }, ended: true },
              {
                span_attributes: { name: "gpt-5.5", type: "llm" },
                output: { role: "assistant", content: "done" },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  test("a model call with no closing token_count is closed when the turn ends", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        turnContext({ model: "gpt-5.5" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "hi" }),
        assistantMessage("partial"),
        // No token_count; turn completes anyway.
        taskComplete({ turn_id: "t1", last_agent_message: "partial" }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            ended: true,
            children: [
              {
                span_attributes: { name: "gpt-5.5", type: "llm" },
                output: { role: "assistant", content: "partial" },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });
});

describe("CodexEventProcessor: config / master switch", () => {
  test("a config event builds the per-session factory with its config", async () => {
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

    const reader = new FakeTranscriptReader();
    const processor = new CodexEventProcessor("sess-1", createTestLogger(), provider, reader);
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
    await processor.process(cfg);
    // Factory is built lazily on first span (session_meta).
    reader.append(
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00Z",
        type: "session_meta",
        payload: { id: "sess-1", cwd: "/work" },
      }),
    );
    await processor.process(sessionStart({ session_id: "sess-1" }));

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
      [
        configEvent({ project: "team-project" }),
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        stop({}),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        metadata: { project: "team-project" },
        children: [],
      },
    );
  });

  test("when tracing is disabled, no spans are produced", async () => {
    const reader = new FakeTranscriptReader();
    const trace = withCapturedTrace();
    try {
      const processor = new CodexEventProcessor(
        "s",
        createTestLogger(),
        () => trace.spanFactory,
        reader,
      );
      // Config event WITHOUT traceToBraintrust (defaults off).
      await processor.process({
        queueId: "s",
        eventSource: "codex-hook",
        eventSourceVersion: null,
        eventName: CODEX_CONFIG_EVENT,
        eventData: { project: "p" },
      });
      reader.append(
        JSON.stringify({
          timestamp: "2026-01-01T00:00:00Z",
          type: "session_meta",
          payload: { id: "s", cwd: "/work" },
        }),
      );
      await processor.process(sessionStart({ session_id: "s" }));
      await processor.process(stop({ session_id: "s", turn_id: "t1" }));
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
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        turnContext({ model: "gpt-5.5" }),
        stop({}),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        metadata: { team: "platform", model: "gpt-5.5", project: "team-project" },
        children: [],
      },
    );
  });
});

describe("CodexEventProcessor: transcript catch-up plumbing", () => {
  test("each hook reads from the advancing offset (each line read once)", async () => {
    const reader = new FakeTranscriptReader();
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "hi" }),
        taskComplete({ turn_id: "t1", last_agent_message: "yo" }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [{ span_attributes: { name: "turn: t1", type: "task" }, ended: true }],
      },
      { reader },
    );

    // Reads: SessionStart (readFrom), Stop (waitFor). The injected config event
    // has no transcript_path, so it does not read.
    expect(reader.readOffsets.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < reader.readOffsets.length; i++) {
      expect(reader.readOffsets[i]).toBeGreaterThanOrEqual(reader.readOffsets[i - 1] as number);
    }
    expect(reader.readOffsets[0]).toBe(0);
  });

  test("a malformed transcript line is skipped without breaking handling", async () => {
    const reader = new FakeTranscriptReader();
    reader.append("this is not valid json");
    await assertProducesTrace(
      [sessionStart(), sessionMeta({ cwd: "/work" }), stop({ turn_id: "t1" })],
      { span_attributes: { name: "codex: work", type: "task" }, ended: true, children: [] },
      { reader },
    );
  });

  test("a turn whose task_complete lands after its Stop is closed by the bounded wait", async () => {
    // Regression for the live bug: Codex writes task_complete seconds after the
    // Stop hook fires. The Stop's initial read doesn't see it (turn stays open),
    // so the bounded waitFor must keep reading until it appears, then close the
    // turn — with the transcript-derived end time, not a wall-clock value.
    class DelayedRevealReader implements TranscriptReader {
      private lines: string[] = [];
      private withheld: string | null = null;
      private readsUntilReveal = 0;

      append(line: string): void {
        this.lines.push(line);
      }

      /** Append a line that only becomes visible after `afterReads` more reads. */
      withhold(line: string, afterReads: number): void {
        this.withheld = line;
        this.readsUntilReveal = afterReads;
      }

      private visible(): string[] {
        return this.lines;
      }

      readFrom(_path: string, offset: number): TranscriptReadResult {
        // Reveal the withheld line once enough reads have happened.
        if (this.withheld !== null) {
          if (this.readsUntilReveal <= 0) {
            this.lines.push(this.withheld);
            this.withheld = null;
          } else {
            this.readsUntilReveal -= 1;
          }
        }
        const visible = this.visible();
        const buf = visible.length > 0 ? `${visible.join("\n")}\n` : "";
        const from = offset > buf.length ? 0 : offset;
        const slice = buf.slice(from);
        const out: string[] = [];
        let consumed = 0;
        let lineStart = 0;
        for (let i = 0; i < slice.length; i++) {
          if (slice[i] === "\n") {
            out.push(slice.slice(lineStart, i));
            lineStart = i + 1;
            consumed = lineStart;
          }
        }
        return { lines: out, offset: from + consumed };
      }

      async waitFor(
        path: string,
        offset: number,
        predicate: (line: string) => boolean,
        _opts: WaitForOptions,
      ): Promise<TranscriptWaitResult> {
        const { lines, offset: next } = this.readFrom(path, offset);
        return { lines, offset: next, sentinelFound: lines.some(predicate) };
      }
    }

    const reader = new DelayedRevealReader();
    reader.append(
      JSON.stringify({
        timestamp: "2026-01-01T00:00:10Z",
        type: "session_meta",
        payload: { id: "s", cwd: "/work" },
      }),
    );
    reader.append(
      JSON.stringify({
        timestamp: "2026-01-01T00:00:11Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t1" },
      }),
    );
    // task_complete is withheld: not visible at the Stop's waitFor, appears later.
    reader.withhold(
      JSON.stringify({
        timestamp: "2026-01-01T00:00:15Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t1", last_agent_message: "done" },
      }),
      1,
    );

    const trace = withCapturedTrace();
    try {
      const processor = new CodexEventProcessor(
        "s",
        createTestLogger(),
        () => trace.spanFactory,
        reader,
      );
      await processor.process(configEvent({ session_id: "s" }));
      await processor.process(sessionStart({ session_id: "s" }));
      // Stop's bounded wait won't see task_complete yet; turn stays open.
      await processor.process(stop({ session_id: "s", turn_id: "t1" }));
      // flush polls until the withheld task_complete is revealed and closes t1.
      await processor.flush();

      const tree = spansToTree(await trace.drain());
      const turn = tree?.children[0];
      expect(turn?.name).toBe("turn: t1");
      expect(turn?.metrics?.end).toBe(1767225615); // 2026-01-01T00:00:15Z
    } finally {
      trace.cleanup();
    }
  });
});
