import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ReportingConfig, SpanFactory } from "../../braintrust/logger.ts";
import type { EnqueueEvent } from "../../server/routes.ts";
import {
  createTestLogger,
  mergeCapturedSpans,
  spansToTree,
  withCapturedTrace,
} from "../../test-helpers.ts";
import { CODEX_CONFIG_EVENT } from "./event-builder.ts";
import { CodexEventProcessor } from "./event-processor.ts";
import {
  assertProducesTrace,
  assistantMessage,
  compacted,
  configEvent,
  customToolCall,
  customToolCallOutput,
  FakeTranscriptReader,
  functionCall,
  functionCallOutput,
  MultiFileTranscriptReader,
  postCompact,
  postToolUse,
  preCompact,
  preToolUse,
  reasoning,
  sessionMeta,
  sessionStart,
  stop,
  subagentStart,
  subagentStop,
  TEST_TRANSCRIPT_PATH,
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

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeGitRepo(): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), "codex-git-metadata-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://token@github.com/acme/app.git"], {
    cwd: dir,
  });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  return { dir, commit };
}

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
        metadata: {
          session_id: "session-1",
          model: "gpt-5.5",
          source: "startup",
          transcript_path: TEST_TRANSCRIPT_PATH,
        },
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

  test("root span metadata includes minimal git attribution fields", async () => {
    const repo = makeGitRepo();

    await assertProducesTrace([sessionStart(), sessionMeta({ cwd: repo.dir }), stop({})], {
      span_attributes: { type: "task" },
      metadata: {
        git_origin_url: "https://github.com/acme/app.git",
        git_branch: "main",
        git_commit_sha: repo.commit,
      },
      children: [],
    });
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

  test("root span can attach to a configured parent trace", async () => {
    const reader = new FakeTranscriptReader();
    const trace = withCapturedTrace();
    try {
      const processor = new CodexEventProcessor(
        "session-1",
        createTestLogger(),
        () => trace.spanFactory,
        reader,
      );

      await processor.process(
        configEvent({ parentSpanId: "parent-span", rootSpanId: "root-span" }),
      );
      await processor.process(sessionStart());
      reader.append(JSON.stringify(sessionMeta({ cwd: "/work" }).record));
      reader.append(JSON.stringify(taskStarted({ turn_id: "t1" }).record));
      reader.append(JSON.stringify(userMessage({ message: "hello" }).record));
      reader.append(
        JSON.stringify(taskComplete({ turn_id: "t1", last_agent_message: "done" }).record),
      );
      await processor.process(stop({ turn_id: "t1" }));
      await processor.flush();

      const spans = mergeCapturedSpans(await trace.drain());
      const root = spans.find((s) => s.span_attributes?.name === "codex: work");
      expect(root).toBeDefined();
      if (root === undefined) throw new Error("expected Codex root span");
      expect(root?.root_span_id).toBe("root-span");
      expect(root?.span_parents).toEqual(["parent-span"]);

      const turn = spans.find((s) => s.span_attributes?.name === "turn: t1");
      expect(turn).toBeDefined();
      expect(turn?.root_span_id).toBe("root-span");
      expect(turn?.span_parents).toEqual([root.span_id]);
    } finally {
      trace.cleanup();
    }
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
            children: [
              { span_attributes: { name: "llm", type: "llm" }, ended: true },
              { span_attributes: { name: "exec_command", type: "tool" }, ended: true },
            ],
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
  test("an llm span starts at its turn's start (first child), not its output record", async () => {
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
        // LLM call: the assistant message lands at (:12) — but the model's work
        // for this call began at the turn's start (:11), since this is the first
        // child. It requests a tool (:13) — that's its last output, so the llm
        // span ends there. The tool result arrives (:14) and the token_count
        // (:15) supplies metrics only (it does NOT define the llm span's end).
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
                // LLM call: starts at the turn's start (:11, first child), not
                // the message record (:12); ENDS when it emits the tool call (:13),
                // its last output — NOT at token_count (:15). This is the fix for
                // the llm span swallowing the tool's execution.
                span_attributes: { name: "llm", type: "llm" },
                metrics: { start: 1767225611, end: 1767225613 },
                ended: true,
              },
              {
                // Tool span uses its own record timestamps: function_call (:13)
                // to function_call_output (:14). Contiguous with the llm (no
                // overlap): llm ends at :13, tool starts at :13.
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

  // When an llm call is the only child of its turn, its span should span almost
  // the whole turn (start at turn start, end at token_count just before
  // task_complete) — not appear near-instant.
  test("a lone llm span fills its turn", async () => {
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
        // The model "thinks" for several seconds; its output only lands at :15.
        transcript({
          type: "response_item",
          timestamp: "2026-01-01T00:00:15Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        }),
        transcript({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:15Z",
          payload: { type: "token_count", info: { last_token_usage: { total_tokens: 5 } } },
        }),
        transcript({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:16Z",
          payload: { type: "task_complete", turn_id: "t1", last_agent_message: "answer" },
        }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            metrics: { start: 1767225611, end: 1767225616 },
            children: [
              {
                // Starts at turn start (:11), not the output record (:15).
                span_attributes: { name: "llm", type: "llm" },
                metrics: { start: 1767225611, end: 1767225615 },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  // Regression for the "front-of-turn gap" bug: a model call whose ONLY output is
  // a tool call (no assistant message or readable reasoning before it) must still
  // open an llm span, so the model's work (often many seconds of thinking before
  // it emits the tool call) is covered rather than leaving an unaccounted gap
  // between the turn start and the first child.
  test("a tool-only model call still opens an llm span filling the front of the turn", async () => {
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
        // The model "thinks" for ~20s, then its first (and only) output for this
        // call is a tool call at :30 — no preceding message or reasoning.
        transcript({
          type: "response_item",
          timestamp: "2026-01-01T00:00:30Z",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "c1",
            metadata: { turn_id: "t1" },
          },
        }),
        transcript({
          type: "response_item",
          timestamp: "2026-01-01T00:00:32Z",
          payload: { type: "function_call_output", call_id: "c1", output: "ok" },
        }),
        transcript({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:32Z",
          payload: { type: "token_count", info: { last_token_usage: { total_tokens: 5 } } },
        }),
        transcript({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:33Z",
          payload: { type: "task_complete", turn_id: "t1", last_agent_message: "done" },
        }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            metrics: { start: 1767225611, end: 1767225633 },
            children: [
              {
                // The llm span covers the model's work from the turn start (:11)
                // until it emits the tool call (:30, its only output) — filling
                // the ~20s "thinking" gap. It does NOT extend to the token_count
                // (:32); that would overlap the tool, which is impossible.
                span_attributes: { name: "llm", type: "llm" },
                metrics: { start: 1767225611, end: 1767225630 },
                ended: true,
              },
              {
                // The tool runs :30 -> :32, contiguous with (not inside) the llm.
                span_attributes: { name: "exec_command", type: "tool" },
                metrics: { start: 1767225630, end: 1767225632 },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  // Two model calls separated by a tool: the second call must start where the
  // tool ended (the model's most recent sibling), so the spans tile the turn
  // contiguously instead of each looking instant.
  test("a later llm span starts where the prior sibling (a tool) ended", async () => {
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
        // Call 1: opens at turn start (:11) on its first output item (an
        // assistant message at :11), then emits a tool call (:12, its last
        // output → llm-1 ends there). The token_count (:13) is metrics-only.
        transcript({
          type: "response_item",
          timestamp: "2026-01-01T00:00:11Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "let me check" }],
          },
        }),
        transcript({
          type: "response_item",
          timestamp: "2026-01-01T00:00:12Z",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "c1",
            metadata: { turn_id: "t1" },
          },
        }),
        transcript({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:13Z",
          payload: { type: "token_count", info: { last_token_usage: { total_tokens: 5 } } },
        }),
        // Tool runs :12 -> :14 (output lands after call 1's token_count).
        transcript({
          type: "response_item",
          timestamp: "2026-01-01T00:00:14Z",
          payload: { type: "function_call_output", call_id: "c1", output: "ok" },
        }),
        // Call 2: the model resumes after the tool result. Its output lands at
        // :18, but it began working when the tool returned (:14).
        transcript({
          type: "response_item",
          timestamp: "2026-01-01T00:00:18Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        }),
        transcript({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:18Z",
          payload: { type: "token_count", info: { last_token_usage: { total_tokens: 5 } } },
        }),
        transcript({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:19Z",
          payload: { type: "task_complete", turn_id: "t1", last_agent_message: "done" },
        }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            children: [
              {
                // Call 1: turn start (:11) -> its last output, the tool call
                // (:12). Contiguous with the tool; does NOT extend to :13/:14.
                span_attributes: { name: "llm", type: "llm" },
                metrics: { start: 1767225611, end: 1767225612 },
                ended: true,
              },
              {
                // Tool: :12 -> :14.
                span_attributes: { name: "exec_command", type: "tool" },
                metrics: { start: 1767225612, end: 1767225614 },
                ended: true,
              },
              {
                // Call 2: starts at the tool's end (:14), the most recent sibling
                // end — NOT its own output record (:18). Ends at its last output,
                // the message (:18). The token_count (:18) is metrics-only.
                span_attributes: { name: "llm", type: "llm" },
                metrics: { start: 1767225614, end: 1767225618 },
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
              // The model call that emitted the tool call (its only output) opens
              // an llm span, so the model's work isn't an unaccounted gap.
              { span_attributes: { name: "llm", type: "llm" }, ended: true },
              {
                span_attributes: { name: "exec_command", type: "tool" },
                input: '{"cmd":"ls"}',
                output: "file.txt",
                metadata: {
                  tool_name: "exec_command",
                  call_id: "call_1",
                  turn_id: "t1",
                  tool_approval: "approved",
                },
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
              { span_attributes: { name: "llm", type: "llm" }, ended: true },
              {
                span_attributes: { name: "apply_patch", type: "tool" },
                input: "*** Begin Patch",
                output: "Success",
                metadata: { tool_approval: "approved" },
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
              // Both tool calls come from one model call, so a single llm span
              // opens (on the first tool call) and closes at turn end.
              { span_attributes: { name: "llm", type: "llm" }, ended: true },
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
              { span_attributes: { name: "llm", type: "llm" }, ended: true },
              {
                span_attributes: { name: "exec_command", type: "tool" },
                input: "{}",
                metadata: { tool_approval: "approved" },
                error: "Tool output missing before turn ended",
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

describe("CodexEventProcessor: permissions", () => {
  test("a SKILL.md read is normalized as a skill load tool span", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        functionCall({
          turn_id: "t1",
          name: "exec_command",
          call_id: "c1",
          arguments: JSON.stringify({ command: "cat /home/user/.agents/skills/review/SKILL.md" }),
        }),
        functionCallOutput({ call_id: "c1", output: "loaded" }),
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
              { span_attributes: { name: "llm", type: "llm" }, ended: true },
              {
                span_attributes: { name: "skill: review", type: "tool" },
                metadata: {
                  tool_name: "exec_command",
                  tool_kind: "skill",
                  call_id: "c1",
                  skill_name: "review",
                  skill_path: "/home/user/.agents/skills/review/SKILL.md",
                },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  test("an explicit $skill request is recorded on the turn and matching load span", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "$review inspect this" }),
        functionCall({
          turn_id: "t1",
          name: "exec_command",
          call_id: "c1",
          arguments: JSON.stringify({ command: "cat /home/user/.agents/skills/review/SKILL.md" }),
        }),
        functionCallOutput({ call_id: "c1", output: "loaded" }),
        taskComplete({ turn_id: "t1", last_agent_message: "done" }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            input: "$review inspect this",
            metadata: {
              turn_id: "t1",
              loaded_skill_names: ["review"],
              loaded_skills: [{ name: "review" }],
            },
            ended: true,
            children: [
              { span_attributes: { name: "llm", type: "llm" }, ended: true },
              {
                span_attributes: { name: "skill: review", type: "tool" },
                metadata: {
                  tool_name: "exec_command",
                  tool_kind: "skill",
                  call_id: "c1",
                  skill_name: "review",
                  skill_path: "/home/user/.agents/skills/review/SKILL.md",
                  skill_load_trigger: "explicit",
                },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  test("plain /skills does not create explicit skill metadata", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "/skills" }),
        functionCall({
          turn_id: "t1",
          name: "exec_command",
          call_id: "c1",
          arguments: JSON.stringify({ command: "cat /home/user/.agents/skills/review/SKILL.md" }),
        }),
        functionCallOutput({ call_id: "c1", output: "loaded" }),
        taskComplete({ turn_id: "t1", last_agent_message: "done" }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            metadata: {
              turn_id: "t1",
              loaded_skill_names: undefined,
              loaded_skills: undefined,
            },
            ended: true,
            children: [
              { span_attributes: { name: "llm", type: "llm" }, ended: true },
              {
                span_attributes: { name: "skill: review", type: "tool" },
                metadata: { skill_name: "review", skill_load_trigger: undefined },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  test("visible injected skill fragments are recorded as explicit requests", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        userMessageItem('<skill name="review">---\nname: review\n---</skill>'),
        functionCall({
          turn_id: "t1",
          name: "skills.read",
          call_id: "c1",
          arguments: JSON.stringify({ name: "review" }),
        }),
        functionCallOutput({ call_id: "c1", output: "loaded" }),
        taskComplete({ turn_id: "t1", last_agent_message: "done" }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            metadata: {
              turn_id: "t1",
              loaded_skill_names: ["review"],
              loaded_skills: [{ name: "review" }],
            },
            ended: true,
            children: [
              { span_attributes: { name: "llm", type: "llm" }, ended: true },
              {
                span_attributes: { name: "skill: review", type: "tool" },
                metadata: {
                  tool_name: "skills.read",
                  tool_kind: "skill",
                  call_id: "c1",
                  skill_name: "review",
                  skill_load_trigger: "explicit",
                },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  test("an escalated tool call is annotated with permission metadata and a tag", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        functionCall({
          turn_id: "t1",
          name: "exec_command",
          call_id: "c1",
          arguments: JSON.stringify({
            cmd: "curl example.com",
            sandbox_permissions: "require_escalated",
            justification: "Need network access",
            prefix_rule: ["curl"],
          }),
        }),
        functionCallOutput({ call_id: "c1", output: "ok" }),
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
              { span_attributes: { name: "llm", type: "llm" }, ended: true },
              {
                span_attributes: { name: "exec_command", type: "tool" },
                metadata: {
                  permission: {
                    sandbox_permissions: "require_escalated",
                    justification: "Need network access",
                    prefix_rule: ["curl"],
                  },
                },
                tags: ["permission-request"],
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  // An escalation is a failed sandboxed attempt followed by an escalated retry.
  // Both are separate tool spans (distinct call_ids); only the retry carries the
  // permission annotation.
  test("a sandboxed attempt then escalated retry: only the retry is annotated", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        functionCall({
          turn_id: "t1",
          name: "exec_command",
          call_id: "attempt",
          arguments: JSON.stringify({ cmd: "curl example.com" }),
        }),
        functionCallOutput({ call_id: "attempt", output: "Error: network blocked" }),
        functionCall({
          turn_id: "t1",
          name: "exec_command",
          call_id: "retry",
          arguments: JSON.stringify({
            cmd: "curl example.com",
            sandbox_permissions: "require_escalated",
            justification: "Need network access",
          }),
        }),
        functionCallOutput({ call_id: "retry", output: "ok" }),
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
              // Both attempts come from one model call, so a single llm span opens.
              { span_attributes: { name: "llm", type: "llm" }, ended: true },
              {
                // The failed sandboxed attempt: no permission annotation.
                span_attributes: { name: "exec_command", type: "tool" },
                metadata: { call_id: "attempt", permission: undefined, tool_approval: "approved" },
                output: "Error: network blocked",
                error: "Error: network blocked",
                ended: true,
              },
              {
                // The escalated retry: annotated.
                span_attributes: { name: "exec_command", type: "tool" },
                metadata: {
                  call_id: "retry",
                  permission: {
                    sandbox_permissions: "require_escalated",
                    justification: "Need network access",
                  },
                  tool_approval: "approved",
                },
                tags: ["permission-request"],
                output: "ok",
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  test("a non-escalated tool call has no permission metadata or tag", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        taskStarted({ turn_id: "t1" }),
        functionCall({
          turn_id: "t1",
          name: "exec_command",
          call_id: "c1",
          arguments: JSON.stringify({ cmd: "ls" }),
        }),
        functionCallOutput({ call_id: "c1", output: "file.txt" }),
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
              { span_attributes: { name: "llm", type: "llm" }, ended: true },
              {
                span_attributes: { name: "exec_command", type: "tool" },
                metadata: { permission: undefined },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });
});

describe("CodexEventProcessor: compaction", () => {
  // A compaction is its own turn containing a `compacted` record. That turn span
  // is relabeled "compaction", tagged, annotated, and given an llm child span
  // showing what the compaction did (input = prior history; output = the
  // replacement history). The trigger comes from the compact hooks, and the turn
  // is terminated by PostCompact (a compaction turn gets no Stop of its own).
  test("a compaction turn becomes a compaction span with an llm child", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        turnContext({ model: "gpt-5.5" }),
        taskStarted({ turn_id: "tc" }),
        preCompact({ turn_id: "tc", trigger: "manual" }),
        compacted({
          message: "",
          replacement_history: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
            { type: "compaction", encrypted_content: "opaque" },
          ],
          window_id: 1,
        }),
        tokenCount({ total_tokens: 6451 }),
        taskComplete({ turn_id: "tc", last_agent_message: null }),
        postCompact({ turn_id: "tc", trigger: "manual" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        children: [
          {
            span_attributes: { name: "compaction", type: "task" },
            metadata: {
              compaction: { trigger: "manual", replaced_message_count: 2, window_id: 1 },
            },
            tags: ["compaction"],
            ended: true,
            children: [
              {
                span_attributes: { name: "gpt-5.5", type: "llm" },
                metadata: { compaction: true },
                // Output is shaped as the kept context + a clear summary marker
                // (the real summary is encrypted), not the raw replacement list.
                output: {
                  summary: "[summary unavailable — encrypted by Codex]",
                  kept_messages: [
                    {
                      type: "message",
                      role: "user",
                      content: [{ type: "input_text", text: "hi" }],
                    },
                  ],
                },
                metrics: { tokens: 6451 },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  // The trigger must be captured whether the hook arrives before or after the
  // transcript's compacted record. Here the hook comes AFTER (e.g. a resumed
  // session whose compacted record is read during SessionStart's catch-up); the
  // trigger is back-filled onto the already-built span.
  test("trigger is back-filled when the compact hook arrives after the record", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        turnContext({ model: "gpt-5.5" }),
        taskStarted({ turn_id: "tc" }),
        compacted({ replacement_history: [{ type: "compaction" }], window_id: 2 }),
        tokenCount({ total_tokens: 10 }),
        taskComplete({ turn_id: "tc", last_agent_message: null }),
        // Stop processes the compacted record (trigger not yet known)...
        stop({ turn_id: "tc" }),
        // ...then the PostCompact hook reveals the trigger, back-filled onto the span.
        postCompact({ turn_id: "tc", trigger: "auto" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        children: [
          {
            span_attributes: { name: "compaction", type: "task" },
            metadata: {
              compaction: { trigger: "auto", replaced_message_count: 1, window_id: 2 },
            },
            tags: ["compaction"],
          },
        ],
      },
    );
  });

  // Regression for the live bug: a compaction turn gets no Stop, and PostCompact
  // fires BEFORE Codex writes the turn's task_complete. PostCompact must do the
  // same bounded wait Stop does, so the compaction span closes within the hook
  // instead of lingering open until idle eviction (where it may never flush).
  test("PostCompact waits for a task_complete that lands after it, closing the span", async () => {
    class DelayedRevealReader implements TranscriptReader {
      private lines: string[] = [];
      private withheld: string | null = null;
      private readsUntilReveal = 0;

      append(line: string): void {
        this.lines.push(line);
      }

      withhold(line: string, afterReads: number): void {
        this.withheld = line;
        this.readsUntilReveal = afterReads;
      }

      readFrom(_path: string, offset: number): TranscriptReadResult {
        if (this.withheld !== null) {
          if (this.readsUntilReveal <= 0) {
            this.lines.push(this.withheld);
            this.withheld = null;
          } else {
            this.readsUntilReveal -= 1;
          }
        }
        const buf = this.lines.length > 0 ? `${this.lines.join("\n")}\n` : "";
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
    const write = (record: Record<string, unknown>) =>
      reader.append(JSON.stringify({ timestamp: "2026-01-01T00:00:10Z", ...record }));
    write({ type: "session_meta", payload: { id: "s", cwd: "/work" } });
    write({ type: "event_msg", payload: { type: "task_started", turn_id: "tc" } });
    write({
      timestamp: "2026-01-01T00:00:11Z",
      type: "compacted",
      payload: { replacement_history: [{ type: "compaction" }], window_id: 1 },
    });
    write({
      timestamp: "2026-01-01T00:00:11Z",
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: {} } },
    });
    // task_complete is withheld until after PostCompact's initial read, so only
    // its bounded waitFor reveals it.
    reader.withhold(
      JSON.stringify({
        timestamp: "2026-01-01T00:00:15Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "tc", last_agent_message: null },
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
      await processor.process(preCompact({ session_id: "s", turn_id: "tc", trigger: "manual" }));
      // PostCompact's initial read won't see task_complete; its bounded wait must.
      await processor.process(postCompact({ session_id: "s", turn_id: "tc", trigger: "manual" }));

      const tree = spansToTree(await trace.drain());
      const compaction = tree?.children.find((c) => c.name === "compaction");
      expect(compaction).toBeDefined();
      // The span closed within the hook (end time from the late task_complete).
      expect(compaction?.metrics?.end).toBe(1767225615); // 2026-01-01T00:00:15Z
    } finally {
      trace.cleanup();
    }
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

  test("llm token metrics normalize alternate and nested usage shapes", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        turnContext({ model: "gpt-5.5" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "yo!" }),
        assistantMessage("Hey."),
        tokenCount({
          prompt_tokens: 100,
          completion_tokens: 14,
          prompt_tokens_details: { cached_tokens: 25, cache_creation_tokens: 7 },
          completion_tokens_details: { reasoning_tokens: 4 },
          cost: 0.1234,
        }),
        taskComplete({ turn_id: "t1", last_agent_message: "Hey." }),
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
                output: { role: "assistant", content: "Hey." },
                metrics: {
                  prompt_tokens: 100,
                  completion_tokens: 14,
                  tokens: 114,
                  prompt_cached_tokens: 25,
                  prompt_cache_creation_tokens: 7,
                  completion_reasoning_tokens: 4,
                  cost: 0.1234,
                  estimated_cost: 0.1234,
                },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  test("a dangling llm span records why token usage is unavailable", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        turnContext({ model: "gpt-5.5" }),
        taskStarted({ turn_id: "t1" }),
        userMessage({ message: "yo!" }),
        assistantMessage("Hey."),
        taskComplete({ turn_id: "t1", last_agent_message: "Hey." }),
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
                output: { role: "assistant", content: "Hey." },
                metadata: { usage_unavailable_reason: "codex_transcript_missing_token_count" },
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  // A reasoning item with a readable summary is surfaced as a `reasoning` entry
  // in the llm output (Braintrust's OpenAI Responses shape), interleaved before
  // the assistant message.
  test("a reasoning summary is captured as a reasoning item in the llm output", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        turnContext({ model: "gpt-5.5" }),
        taskStarted({ turn_id: "t1" }),
        userMessageItem("solve it"),
        reasoning(["**Inspecting the problem**", "**Deriving the formula**"]),
        assistantMessage("The answer is 42."),
        tokenCount({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }),
        taskComplete({ turn_id: "t1", last_agent_message: "The answer is 42." }),
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
                output: [
                  {
                    type: "reasoning",
                    summary: [
                      { type: "summary_text", text: "**Inspecting the problem**" },
                      { type: "summary_text", text: "**Deriving the formula**" },
                    ],
                  },
                  { role: "assistant", content: "The answer is 42." },
                ],
                ended: true,
              },
            ],
          },
        ],
      },
    );
  });

  // A reasoning item with only encrypted content (no readable summary) opens the
  // llm span but adds nothing to the output.
  test("an encrypted-only reasoning item adds no reasoning to the output", async () => {
    await assertProducesTrace(
      [
        sessionStart(),
        sessionMeta({ cwd: "/work" }),
        turnContext({ model: "gpt-5.5" }),
        taskStarted({ turn_id: "t1" }),
        userMessageItem("hi"),
        reasoning(), // no summary
        assistantMessage("Hello."),
        tokenCount({ total_tokens: 5 }),
        taskComplete({ turn_id: "t1", last_agent_message: "Hello." }),
        stop({ turn_id: "t1" }),
      ],
      {
        span_attributes: { name: "codex: work", type: "task" },
        children: [
          {
            span_attributes: { name: "turn: t1", type: "task" },
            children: [
              {
                span_attributes: { name: "gpt-5.5", type: "llm" },
                // Single assistant message only — no reasoning entry.
                output: { role: "assistant", content: "Hello." },
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
      rehydrateSpan: () =>
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
      parentSpanId: undefined,
      rootSpanId: undefined,
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

describe("CodexEventProcessor: subagents", () => {
  const MAIN = "/test/main.jsonl";
  const SUB = "/test/sub.jsonl";

  // A main session that spawns one subagent. The subagent writes to its own
  // transcript file; the processor must nest its full hierarchy (subagent root
  // -> turn -> llm/tool) under the spawn_agent tool span that launched it, and
  // never let the two files' offsets cross-contaminate.
  test("a subagent renders as a nested trace under its spawn_agent tool", async () => {
    const reader = new MultiFileTranscriptReader();
    const w = (path: string, record: Record<string, unknown>) =>
      reader.append(path, JSON.stringify(transcript(record).record));
    const trace = withCapturedTrace();
    try {
      const processor = new CodexEventProcessor(
        "s",
        createTestLogger(),
        () => trace.spanFactory,
        reader,
      );
      await processor.process(configEvent({ session_id: "s" }));

      // Main session: root + a turn that calls spawn_agent.
      w(MAIN, { type: "session_meta", payload: { id: "s", cwd: "/work/app" } });
      w(MAIN, { type: "event_msg", payload: { type: "task_started", turn_id: "main-1" } });
      w(MAIN, { type: "turn_context", payload: { model: "gpt-5.5" } });
      w(MAIN, { type: "response_item", payload: { type: "reasoning", summary: [] } });
      w(MAIN, {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call_spawn",
          arguments: "{}",
          metadata: { turn_id: "main-1" },
        },
      });
      w(MAIN, {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_spawn", output: "{}" },
      });
      w(MAIN, {
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: {} } },
      });
      await processor.process(sessionStart({ session_id: "s", transcript_path: MAIN }));
      await processor.process(
        preToolUse({
          session_id: "s",
          transcript_path: MAIN,
          tool_name: "spawn_agent",
          tool_use_id: "call_spawn",
        }),
      );
      // PostToolUse reveals the agent_id; maps it to the spawn tool span.
      await processor.process(
        postToolUse({
          session_id: "s",
          transcript_path: MAIN,
          tool_name: "spawn_agent",
          tool_use_id: "call_spawn",
          tool_response: JSON.stringify({ agent_id: "agent-1" }),
        }),
      );

      // Subagent: its own transcript + lifecycle hooks (carry agent_id).
      w(SUB, { type: "session_meta", payload: { id: "agent-1" } });
      w(SUB, { type: "event_msg", payload: { type: "task_started", turn_id: "sub-1" } });
      w(SUB, { type: "turn_context", payload: { model: "gpt-5.5" } });
      w(SUB, { type: "response_item", payload: { type: "reasoning", summary: [] } });
      w(SUB, {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call_exec",
          arguments: "{}",
          metadata: { turn_id: "sub-1" },
        },
      });
      w(SUB, {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_exec", output: "ok" },
      });
      w(SUB, {
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: {} } },
      });
      w(SUB, {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "sub-1", last_agent_message: "sub done" },
      });
      await processor.process(
        subagentStart({
          session_id: "s",
          transcript_path: SUB,
          agent_id: "agent-1",
          agent_type: "default",
        }),
      );
      await processor.process(
        subagentStop({
          session_id: "s",
          transcript_path: MAIN,
          agent_transcript_path: SUB,
          agent_id: "agent-1",
        }),
      );

      // Main session completes.
      w(MAIN, {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "main-1", last_agent_message: "all done" },
      });
      await processor.process(stop({ session_id: "s", transcript_path: MAIN, turn_id: "main-1" }));
      await processor.flush();

      const tree = spansToTree(await trace.drain());
      expect(tree?.name).toBe("codex: app");
      // The root carries the main session's transcript path.
      expect(tree?.metadata?.transcript_path).toBe(MAIN);
      const mainTurn = tree?.children.find((c) => c.name === "turn: main-1");
      expect(mainTurn).toBeDefined();

      // The spawn_agent tool span is under the main turn, and the subagent root
      // is a SIBLING of it (both under the main turn) — not nested in the tool.
      const spawn = mainTurn?.children.find((c) => c.name === "spawn_agent");
      expect(spawn?.type).toBe("tool");
      expect(spawn?.children.some((c) => c.name === "subagent: agent-1")).toBe(false);
      const subRoot = mainTurn?.children.find((c) => c.name === "subagent: agent-1");
      expect(subRoot).toBeDefined();
      expect(subRoot?.type).toBe("task");
      // The subagent root carries its own transcript path.
      expect(subRoot?.metadata?.transcript_path).toBe(SUB);

      const subTurn = subRoot?.children.find((c) => c.name === "turn: sub-1");
      expect(subTurn).toBeDefined();
      const exec = subTurn?.children.find((c) => c.name === "exec_command");
      expect(exec?.type).toBe("tool");

      // No subagent turn leaked to the top level (the original bug).
      expect(tree?.children.some((c) => c.name === "turn: sub-1")).toBe(false);
    } finally {
      trace.cleanup();
    }
  });

  // Regression for the live bug: after SubagentStop finalizes a subagent, a later
  // flush (which drains every scope) must NOT re-read the subagent transcript and
  // re-open its already-closed spans — doing so left the subagent root/turn/llm
  // hanging (no end) because the re-opened, un-ended spans overwrote the closed
  // ones. A finalized subagent scope must be inert.
  test("a finalized subagent's spans stay closed across later flushes", async () => {
    const reader = new MultiFileTranscriptReader();
    const w = (path: string, record: Record<string, unknown>) =>
      reader.append(path, JSON.stringify(transcript(record).record));
    const trace = withCapturedTrace();
    try {
      const processor = new CodexEventProcessor(
        "s",
        createTestLogger(),
        () => trace.spanFactory,
        reader,
      );
      await processor.process(configEvent({ session_id: "s" }));

      // Main session spawns a subagent and stays open (no main Stop yet).
      w(MAIN, { type: "session_meta", payload: { id: "s", cwd: "/work/app" } });
      w(MAIN, { type: "event_msg", payload: { type: "task_started", turn_id: "main-1" } });
      w(MAIN, {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call_spawn",
          arguments: "{}",
          metadata: { turn_id: "main-1" },
        },
      });
      w(MAIN, {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_spawn", output: "{}" },
      });
      await processor.process(sessionStart({ session_id: "s", transcript_path: MAIN }));
      await processor.process(
        postToolUse({
          session_id: "s",
          transcript_path: MAIN,
          tool_name: "spawn_agent",
          tool_use_id: "call_spawn",
          tool_response: JSON.stringify({ agent_id: "agent-1" }),
        }),
      );

      // Subagent transcript: a turn with a model call, then task_complete, then a
      // TRAILING record after task_complete. SubagentStop's bounded wait stops at
      // the task_complete sentinel, leaving the trailing record unconsumed; a
      // later flush would otherwise re-read it and re-open spans on the finalized
      // scope (the bug). With the fix, the finalized scope is inert.
      w(SUB, { type: "session_meta", payload: { id: "agent-1" } });
      w(SUB, { type: "event_msg", payload: { type: "task_started", turn_id: "sub-1" } });
      w(SUB, { type: "turn_context", payload: { model: "gpt-5.5" } });
      w(SUB, { type: "response_item", payload: { type: "reasoning", summary: [] } });
      w(SUB, {
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: {} } },
      });
      w(SUB, {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "sub-1", last_agent_message: "sub done" },
      });
      await processor.process(
        subagentStart({
          session_id: "s",
          transcript_path: SUB,
          agent_id: "agent-1",
          agent_type: "default",
        }),
      );
      await processor.process(
        subagentStop({
          session_id: "s",
          transcript_path: MAIN,
          agent_transcript_path: SUB,
          agent_id: "agent-1",
        }),
      );

      // After finalize, MORE records land in the subagent transcript (Codex can
      // write trailing records, and the rollout file persists). A later flush
      // drains every scope and re-reads this file. If the finalized scope weren't
      // inert, these would re-open a turn + llm on it, leaving spans hanging.
      w(SUB, { type: "event_msg", payload: { type: "task_started", turn_id: "sub-2" } });
      w(SUB, { type: "response_item", payload: { type: "reasoning", summary: [] } });
      w(SUB, {
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: {} } },
      });
      await processor.flush();

      // Main session finishes.
      w(MAIN, {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "main-1", last_agent_message: "done" },
      });
      await processor.process(stop({ session_id: "s", transcript_path: MAIN, turn_id: "main-1" }));
      await processor.flush();

      const tree = spansToTree(await trace.drain());
      // The subagent root is a sibling of the spawn_agent tool (under main-1).
      const mainTurn = tree?.children.find((c) => c.name === "turn: main-1");
      const subRoot = mainTurn?.children.find((c) => c.name === "subagent: agent-1");
      const subTurn = subRoot?.children.find((c) => c.name === "turn: sub-1");

      // The subagent root and turn are closed (not hanging), and the post-finalize
      // records did NOT re-open anything: no second turn, no re-opened llm.
      expect(subRoot?.metrics?.end).toBeDefined();
      expect(subTurn?.metrics?.end).toBeDefined();
      expect(subRoot?.children.some((c) => c.name === "turn: sub-2")).toBe(false);
      expect(subRoot?.children.filter((c) => c.name?.startsWith("turn:")).length).toBe(1);
    } finally {
      trace.cleanup();
    }
  });

  // LLM-span start timing is derived per-turn, per-scope, so a subagent's calls
  // must never influence the main session's call timing (or vice versa) even
  // though both run concurrently. Each scope tracks its own turn start /
  // last-child-end, keyed by its own transcript file.
  test("llm span start timing is isolated per scope across concurrent subagents", async () => {
    const reader = new MultiFileTranscriptReader();
    const w = (path: string, record: Record<string, unknown>) =>
      reader.append(path, JSON.stringify(record));
    const trace = withCapturedTrace();
    try {
      const processor = new CodexEventProcessor(
        "s",
        createTestLogger(),
        () => trace.spanFactory,
        reader,
      );
      await processor.process(configEvent({ session_id: "s" }));

      // Main turn starts at :10 and spawns a subagent; its own model call's output
      // lands much later (:30), but the call began at the turn start (:10).
      w(MAIN, {
        timestamp: "2026-01-01T00:00:09Z",
        type: "session_meta",
        payload: { id: "s", cwd: "/work/app" },
      });
      w(MAIN, {
        timestamp: "2026-01-01T00:00:10Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "main-1" },
      });
      w(MAIN, {
        timestamp: "2026-01-01T00:00:10Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call_spawn",
          arguments: "{}",
          metadata: { turn_id: "main-1" },
        },
      });
      w(MAIN, {
        timestamp: "2026-01-01T00:00:11Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_spawn", output: "{}" },
      });
      await processor.process(sessionStart({ session_id: "s", transcript_path: MAIN }));
      await processor.process(
        postToolUse({
          session_id: "s",
          transcript_path: MAIN,
          tool_name: "spawn_agent",
          tool_use_id: "call_spawn",
          tool_response: JSON.stringify({ agent_id: "agent-1" }),
        }),
      );

      // Subagent turn starts at :20 (its own clock); its model output lands at
      // :25 and closes at :25. Its llm span must start at the SUBAGENT turn start
      // (:20), not be affected by the main scope's :10/:11 boundaries.
      w(SUB, {
        timestamp: "2026-01-01T00:00:20Z",
        type: "session_meta",
        payload: { id: "agent-1" },
      });
      w(SUB, {
        timestamp: "2026-01-01T00:00:20Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "sub-1" },
      });
      w(SUB, {
        timestamp: "2026-01-01T00:00:25Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "sub" }],
        },
      });
      w(SUB, {
        timestamp: "2026-01-01T00:00:25Z",
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { total_tokens: 1 } } },
      });
      w(SUB, {
        timestamp: "2026-01-01T00:00:26Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "sub-1", last_agent_message: "sub done" },
      });
      await processor.process(
        subagentStart({
          session_id: "s",
          transcript_path: SUB,
          agent_id: "agent-1",
          agent_type: "default",
        }),
      );
      await processor.process(
        subagentStop({
          session_id: "s",
          transcript_path: MAIN,
          agent_transcript_path: SUB,
          agent_id: "agent-1",
        }),
      );

      // Main session's own model call: output lands at :30, closes at :30. Its
      // llm span must start at the MAIN turn start (:10) — the most recent child
      // of main-1 is the spawn_agent tool (ended :11), so it starts there.
      w(MAIN, {
        timestamp: "2026-01-01T00:00:30Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "main" }],
        },
      });
      w(MAIN, {
        timestamp: "2026-01-01T00:00:30Z",
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { total_tokens: 1 } } },
      });
      w(MAIN, {
        timestamp: "2026-01-01T00:00:31Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "main-1", last_agent_message: "all done" },
      });
      await processor.process(stop({ session_id: "s", transcript_path: MAIN, turn_id: "main-1" }));
      await processor.flush();

      const tree = spansToTree(await trace.drain());
      const mainTurn = tree?.children.find((c) => c.name === "turn: main-1");
      // Main llm: opens on the spawn_agent tool call (the model's first output,
      // before any message), so it starts at the main turn's start (:10 =
      // 1767225610) and runs until its token_count (:30). The single llm call
      // spans the spawn tool and the later message.
      const mainLlm = mainTurn?.children.find((c) => c.name === "llm");
      expect(mainLlm?.metrics?.start).toBe(1767225610);
      expect(mainLlm?.metrics?.end).toBe(1767225630);

      // Subagent llm: starts at the SUBAGENT turn start (:20 = 1767225620), wholly
      // independent of the main scope's boundaries; ends at its token_count (:25).
      const subRoot = mainTurn?.children.find((c) => c.name === "subagent: agent-1");
      const subTurn = subRoot?.children.find((c) => c.name === "turn: sub-1");
      const subLlm = subTurn?.children.find((c) => c.name === "llm");
      expect(subLlm?.metrics?.start).toBe(1767225620);
      expect(subLlm?.metrics?.end).toBe(1767225625);
    } finally {
      trace.cleanup();
    }
  });
});
