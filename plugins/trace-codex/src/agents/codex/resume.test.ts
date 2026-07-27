// Resume / state-persistence tests.
//
// When the event server shuts down mid-session (idle timeout) or the user closes
// and later resumes, a fresh CodexEventProcessor is created for the same session
// id. These tests verify that, given a persisted snapshot, the new processor
// rehydrates the original spans and continues the SAME trace — producing the
// same result as if one processor had handled the whole session — instead of
// duplicating or orphaning spans.

import { describe, expect, test } from "vitest";
import type { SpanFactory } from "../../braintrust/logger.ts";
import {
  type CapturedSpan,
  createTestLogger,
  diffSpan,
  type ExpectedSpan,
  spansToTree,
  withCapturedTrace,
} from "../../test-helpers.ts";
import { CodexEventProcessor } from "./event-processor.ts";
import { SnapshotStore } from "./snapshot-store.ts";
import type { CodexSnapshot } from "./state-snapshot.ts";
import {
  compacted,
  configEvent,
  FakeTranscriptReader,
  functionCall,
  functionCallOutput,
  preToolUse,
  sessionMeta,
  sessionStart,
  stop,
  type TraceEntry,
  taskComplete,
  taskStarted,
  tokenCount,
  transcript,
  turnContext,
  userMessage,
} from "./test-helpers.ts";

/** An in-memory snapshot store, so tests don't touch disk. Mirrors the disk
 * store's surface (the parts the processor uses). */
class MemorySnapshotStore extends SnapshotStore {
  private readonly mem = new Map<string, CodexSnapshot>();

  constructor() {
    super(createTestLogger(), { dir: "/dev/null/unused" });
  }

  override read(sessionId: string): CodexSnapshot | null {
    const snap = this.mem.get(sessionId);
    // Deep-clone so callers can't mutate stored state (matches disk JSON).
    return snap ? (JSON.parse(JSON.stringify(snap)) as CodexSnapshot) : null;
  }

  override write(sessionId: string, snapshot: CodexSnapshot): void {
    this.mem.set(sessionId, JSON.parse(JSON.stringify(snapshot)) as CodexSnapshot);
  }

  override delete(sessionId: string): void {
    this.mem.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.mem.has(sessionId);
  }
}

const isTranscriptEntry = (e: TraceEntry): e is ReturnType<typeof transcript> =>
  (e as { kind?: string }).kind === "transcript";

/**
 * Run a list of entries (hooks + transcript writes) through a processor, then
 * flush. Shares the reader, factory, and store across calls so a second
 * processor can resume the first's session. Returns nothing; spans accumulate in
 * the shared captured trace.
 */
async function runThrough(
  entries: TraceEntry[],
  deps: {
    queueId: string;
    reader: FakeTranscriptReader;
    factory: SpanFactory;
    store: SnapshotStore;
  },
): Promise<void> {
  const processor = new CodexEventProcessor(
    deps.queueId,
    createTestLogger(),
    () => deps.factory,
    deps.reader,
    deps.store,
  );
  for (const entry of entries) {
    if (isTranscriptEntry(entry)) {
      deps.reader.append(JSON.stringify(entry.record));
    } else {
      await processor.process(entry);
    }
  }
  await processor.flush();
}

/** Assert a captured trace matches an expected tree. */
function expectTrace(spans: CapturedSpan[], expected: ExpectedSpan): void {
  const tree = spansToTree(spans);
  const diffs = diffSpan(tree, expected, "root");
  if (diffs.length > 0) {
    throw new Error(`trace does not match expected:\n${diffs.join("\n")}`);
  }
}

describe("CodexEventProcessor: resume from snapshot", () => {
  // The realistic mid-session restart: the server idle-shuts-down DURING a turn
  // (before its Stop), then the next hook arrives on a new processor. The
  // resumed processor must rehydrate the open root + turn and finish them,
  // yielding one trace with the turn closed exactly once (no duplicates).
  test("an idle restart mid-turn rehydrates open spans and finishes them", async () => {
    const trace = withCapturedTrace();
    try {
      const queueId = "sess-midturn";
      const reader = new FakeTranscriptReader();
      const store = new MemorySnapshotStore();
      const deps = { queueId, reader, factory: trace.spanFactory, store };

      // Run 1: open the session and a turn, but NO Stop yet. The SessionStart
      // and a PreToolUse hook drive transcript catch-up (in production every
      // hook does). An idle flush then persists the open state. The config
      // carries an apiKey to prove it's never written to the snapshot.
      await runThrough(
        [
          configEvent({ session_id: queueId, apiKey: "sk-secret-do-not-persist" }),
          sessionMeta({ id: queueId, cwd: "/tmp/proj" }),
          turnContext({ model: "gpt-5.5" }),
          taskStarted({ turn_id: "turn-1" }),
          userMessage({ message: "hello" }),
          sessionStart({ session_id: queueId, source: "startup" }),
          preToolUse({ session_id: queueId }),
        ],
        deps,
      );

      // Mid-session: the root and turn are open, so a snapshot exists.
      expect(store.has(queueId)).toBe(true);
      const snap = store.read(queueId);
      expect(snap?.rootEnded).toBe(false);
      expect(snap?.scopes[0]?.openTurns.length).toBe(1);
      // The persisted snapshot must never contain the apiKey (secret).
      expect(JSON.stringify(snap)).not.toContain("apiKey");

      // Run 2: a NEW processor (server restarted). The first event isn't a
      // SessionStart — it's the Stop closing the turn. The resumed processor
      // must restore the open root+turn and finish them.
      await runThrough(
        [
          // No config event this run: the resumed processor uses the snapshot's
          // reporting config. (In production a resume DOES re-send config, but
          // restore must work without it too.)
          taskComplete({ turn_id: "turn-1", last_agent_message: "all done" }),
          stop({ turn_id: "turn-1" }),
        ],
        deps,
      );

      // The resumed Stop ended the root, but the snapshot is kept (more turns
      // could still follow — Codex's Stop is per-turn, not per-session). It's
      // updated to reflect the now-ended root.
      expect(store.has(queueId)).toBe(true);
      expect(store.read(queueId)?.rootEnded).toBe(true);

      const spans = await trace.drain();
      // Exactly one root, one turn — no duplicates from the restart.
      expectTrace(spans, {
        span_attributes: { name: "codex: proj", type: "task" },
        metadata: { session_id: queueId },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: turn-1", type: "task" },
            input: "hello",
            output: "all done",
            ended: true,
            children: [],
          },
        ],
      });
    } finally {
      trace.cleanup();
    }
  });

  // The /shutdown-between-turns case: turn 1 completes (its Stop fires, which
  // ends the root), the server is shut down, then the user sends another message.
  // The root ending on the first Stop must NOT discard the snapshot — turn 2 has
  // to resume under the SAME root, not start a brand-new trace.
  test("a turn sent after a between-turns shutdown resumes under the same root", async () => {
    const trace = withCapturedTrace();
    try {
      const queueId = "sess-multiturn";
      const reader = new FakeTranscriptReader();
      const store = new MemorySnapshotStore();
      const deps = { queueId, reader, factory: trace.spanFactory, store };

      // Run 1: a full first turn, including its Stop (which ends the root span).
      // Then the server shuts down (we stop using processor A after its flush).
      await runThrough(
        [
          configEvent({ session_id: queueId }),
          sessionMeta({ id: queueId, cwd: "/tmp/proj" }),
          turnContext({ model: "gpt-5.5" }),
          taskStarted({ turn_id: "turn-1" }),
          userMessage({ message: "first" }),
          taskComplete({ turn_id: "turn-1", last_agent_message: "did first" }),
          stop({ turn_id: "turn-1" }),
        ],
        deps,
      );

      // The root ended on turn 1's Stop — but the snapshot must SURVIVE, since
      // more turns can still come (Codex's Stop is per-turn, not per-session).
      expect(store.has(queueId)).toBe(true);
      expect(store.read(queueId)?.rootEnded).toBe(true);

      // Run 2: a NEW processor (server restarted after /shutdown). A second turn
      // arrives. It must attach under the SAME restored root, not a new one.
      await runThrough(
        [
          taskStarted({ turn_id: "turn-2" }),
          userMessage({ message: "second" }),
          taskComplete({ turn_id: "turn-2", last_agent_message: "did second" }),
          stop({ turn_id: "turn-2" }),
        ],
        deps,
      );

      const spans = await trace.drain();
      // One root, two turns under it — a single continuous trace.
      expectTrace(spans, {
        span_attributes: { name: "codex: proj", type: "task" },
        metadata: { session_id: queueId },
        children: [
          {
            span_attributes: { name: "turn: turn-1", type: "task" },
            output: "did first",
            ended: true,
            children: [],
          },
          {
            span_attributes: { name: "turn: turn-2", type: "task" },
            input: "second",
            output: "did second",
            ended: true,
            children: [],
          },
        ],
      });
    } finally {
      trace.cleanup();
    }
  });

  // A deeper hierarchy (turn -> tool) open across the restart must rehydrate with
  // the correct span names (not SDK-inferred ones) and close cleanly.
  test("an open tool span survives a restart and closes with its original name", async () => {
    const trace = withCapturedTrace();
    try {
      const queueId = "sess-tool";
      const reader = new FakeTranscriptReader();
      const store = new MemorySnapshotStore();
      const deps = { queueId, reader, factory: trace.spanFactory, store };

      // Run 1: a turn opens and calls a tool (function_call), but the tool's
      // output hasn't arrived yet when the server idle-shuts-down.
      await runThrough(
        [
          configEvent({ session_id: queueId }),
          sessionMeta({ id: queueId, cwd: "/tmp/proj" }),
          turnContext({ model: "gpt-5.5" }),
          taskStarted({ turn_id: "turn-1" }),
          userMessage({ message: "run a tool" }),
          functionCall({ turn_id: "turn-1", call_id: "call-1", name: "shell" }),
          sessionStart({ session_id: queueId, source: "startup" }),
          preToolUse({ session_id: queueId }),
        ],
        deps,
      );

      const snap = store.read(queueId);
      expect(snap?.scopes[0]?.openTools.length).toBe(1);
      expect(snap?.scopes[0]?.openTools[0]?.span.name).toBe("shell");

      // Run 2: a fresh processor. The tool output and turn completion arrive, then
      // the Stop. The rehydrated tool span must close under the rehydrated turn.
      await runThrough(
        [
          functionCallOutput({ call_id: "call-1", output: "ok" }),
          taskComplete({ turn_id: "turn-1", last_agent_message: "tool done" }),
          stop({ turn_id: "turn-1" }),
        ],
        deps,
      );

      const spans = await trace.drain();
      expectTrace(spans, {
        span_attributes: { name: "codex: proj", type: "task" },
        ended: true,
        children: [
          {
            span_attributes: { name: "turn: turn-1", type: "task" },
            output: "tool done",
            ended: true,
            children: [
              // The model call that emitted the tool call opens an llm span.
              { span_attributes: { name: "gpt-5.5", type: "llm" }, ended: true },
              {
                span_attributes: { name: "shell", type: "tool" },
                output: "ok",
                ended: true,
                children: [],
              },
            ],
          },
        ],
      });
    } finally {
      trace.cleanup();
    }
  });

  // The per-turn timing used to place LLM spans (turn start + last-child-end)
  // must survive a restart, so an LLM call that opens AFTER the restart still
  // starts at the right place (here: the turn's start, since it's the first
  // child) rather than at its post-restart output record.
  test("turn timing survives a restart so a resumed llm span starts correctly", async () => {
    const trace = withCapturedTrace();
    try {
      const queueId = "sess-timing";
      const reader = new FakeTranscriptReader();
      const store = new MemorySnapshotStore();
      const deps = { queueId, reader, factory: trace.spanFactory, store };

      // Run 1: the turn opens at :11 but the model hasn't produced output yet when
      // the server shuts down (no llm span exists yet — only the open turn).
      await runThrough(
        [
          configEvent({ session_id: queueId }),
          transcript({
            timestamp: "2026-01-01T00:00:10Z",
            type: "session_meta",
            payload: { id: queueId, cwd: "/tmp/proj" },
          }),
          transcript({
            timestamp: "2026-01-01T00:00:10Z",
            type: "turn_context",
            payload: { model: "gpt-5.5" },
          }),
          transcript({
            timestamp: "2026-01-01T00:00:11Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-1" },
          }),
          sessionStart({ session_id: queueId, source: "startup" }),
          preToolUse({ session_id: queueId }),
        ],
        deps,
      );

      // The open turn's start time was persisted.
      const snap = store.read(queueId);
      expect(snap?.scopes[0]?.openTurns[0]?.turnId).toBe("turn-1");
      expect(snap?.scopes[0]?.openTurns[0]?.startTime).toBe(1767225611);

      // Run 2: a fresh processor. The model output finally lands (:18) and the
      // call closes (:18). The resumed llm span must start at the turn's start
      // (:11, restored), not at its output record (:18).
      await runThrough(
        [
          transcript({
            timestamp: "2026-01-01T00:00:18Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "hi" }],
            },
          }),
          transcript({
            timestamp: "2026-01-01T00:00:18Z",
            type: "event_msg",
            payload: { type: "token_count", info: { last_token_usage: { total_tokens: 1 } } },
          }),
          transcript({
            timestamp: "2026-01-01T00:00:19Z",
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "hi" },
          }),
          stop({ turn_id: "turn-1" }),
        ],
        deps,
      );

      const spans = await trace.drain();
      const tree = spansToTree(spans);
      const turn = tree?.children.find((c) => c.name === "turn: turn-1");
      const llm = turn?.children.find((c) => c.name === "gpt-5.5" || c.name === "llm");
      // Started at the restored turn start (:11), ended at token_count (:18).
      expect(llm?.metrics?.start).toBe(1767225611);
      expect(llm?.metrics?.end).toBe(1767225618);
    } finally {
      trace.cleanup();
    }
  });

  test("a version-incompatible snapshot is discarded and the session starts fresh", async () => {
    const trace = withCapturedTrace();
    try {
      const queueId = "sess-badver";
      const reader = new FakeTranscriptReader();
      const store = new MemorySnapshotStore();

      // Plant a snapshot with an incompatible plugin version.
      store.write(queueId, {
        pluginVersion: "0.0.0-incompatible",
        schemaVersion: 1,
        sessionId: queueId,
        savedAt: Date.now(),
        reportingConfig: { traceToBraintrust: true },
        rootSpan: { spanId: "stale", rootSpanId: "stale", spanParents: [] },
        rootEnded: false,
        rootEndTime: undefined,
        rootEnrichment: {},
        mainScopePath: "/old.jsonl",
        scopes: [],
        compactionTriggerByTurn: [],
      });

      const deps = { queueId, reader, factory: trace.spanFactory, store };
      await runThrough(
        [
          configEvent({ session_id: queueId }),
          sessionMeta({ id: queueId, cwd: "/tmp/fresh" }),
          turnContext({ model: "gpt-5.5" }),
          taskStarted({ turn_id: "turn-1" }),
          userMessage({ message: "hi" }),
          taskComplete({ turn_id: "turn-1", last_agent_message: "ok" }),
          stop({ turn_id: "turn-1" }),
        ],
        deps,
      );

      const spans = await trace.drain();
      // A fresh trace was built (the stale snapshot's "stale" span id is absent),
      // and the incompatible snapshot was removed.
      expect(spans.some((s) => s.span_id === "stale")).toBe(false);
      expectTrace(spans, {
        span_attributes: { name: "codex: fresh", type: "task" },
        children: [{ span_attributes: { name: "turn: turn-1" }, output: "ok", children: [] }],
      });
    } finally {
      trace.cleanup();
    }
  });

  // Regression for the duplicate/never-closing compaction span: a compaction that
  // FINISHED before the restart must not be re-opened on resume. (Previously the
  // compaction span lived forever in a side-map and was rehydrated — re-emitting
  // it with a fresh start and no end.)
  test("a completed compaction is not re-opened on resume", async () => {
    const trace = withCapturedTrace();
    try {
      const queueId = "sess-compact";
      const reader = new FakeTranscriptReader();
      const store = new MemorySnapshotStore();
      const deps = { queueId, reader, factory: trace.spanFactory, store };

      // Run 1: a turn, then a compaction turn that completes, all before shutdown.
      await runThrough(
        [
          configEvent({ session_id: queueId }),
          transcript({
            timestamp: "2026-01-01T00:00:10Z",
            type: "session_meta",
            payload: { id: queueId, cwd: "/tmp/proj" },
          }),
          transcript({
            timestamp: "2026-01-01T00:00:10Z",
            type: "turn_context",
            payload: { model: "gpt-5.5" },
          }),
          // A normal turn.
          transcript({
            timestamp: "2026-01-01T00:00:11Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-1" },
          }),
          userMessage({ message: "hi" }),
          taskComplete({ turn_id: "turn-1", last_agent_message: "hello" }),
          stop({ turn_id: "turn-1" }),
          // A compaction turn that fully completes.
          transcript({
            timestamp: "2026-01-01T00:00:20Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-2" },
          }),
          compacted({
            replacement_history: [{ type: "message", role: "user", content: [] }],
            window_id: 1,
          }),
          tokenCount({ total_tokens: 5 }),
          transcript({
            timestamp: "2026-01-01T00:00:22Z",
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "turn-2", last_agent_message: "" },
          }),
          // A non-terminal hook drives the catch-up that consumes the above.
          preToolUse({ session_id: queueId }),
        ],
        deps,
      );

      // The compaction span finished in run 1.
      let spans = await trace.drain();
      const compaction1 = spans.find((s) => s.span_attributes?.name === "compaction");
      expect(compaction1?.metrics?.end).toBeDefined();
      const compactionId = compaction1?.span_id;

      // Run 2: a new processor resumes and runs another turn.
      await runThrough(
        [
          transcript({
            timestamp: "2026-01-01T00:00:30Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-3" },
          }),
          userMessage({ message: "again" }),
          taskComplete({ turn_id: "turn-3", last_agent_message: "ok" }),
          stop({ turn_id: "turn-3" }),
        ],
        deps,
      );

      spans = await trace.drain();
      // The compaction span must NOT have been re-emitted (reopened) on resume:
      // run 2 produces no row for its span_id.
      expect(spans.some((s) => s.span_id === compactionId)).toBe(false);
    } finally {
      trace.cleanup();
    }
  });

  // The root span, ended before a restart, must keep its original start AND end
  // after resume — rehydrating it re-emits its row, so we re-assert the end.
  test("a root ended before a restart keeps its original start and end", async () => {
    const trace = withCapturedTrace();
    try {
      const queueId = "sess-rootend";
      const reader = new FakeTranscriptReader();
      const store = new MemorySnapshotStore();
      const deps = { queueId, reader, factory: trace.spanFactory, store };

      // Run 1: a full turn; its Stop ends the root at the turn's end (:13).
      await runThrough(
        [
          configEvent({ session_id: queueId }),
          transcript({
            timestamp: "2026-01-01T00:00:10Z",
            type: "session_meta",
            payload: { id: queueId, cwd: "/tmp/proj" },
          }),
          transcript({
            timestamp: "2026-01-01T00:00:11Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-1" },
          }),
          userMessage({ message: "hi" }),
          transcript({
            timestamp: "2026-01-01T00:00:13Z",
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "hello" },
          }),
          stop({ turn_id: "turn-1" }),
        ],
        deps,
      );

      const snap = store.read(queueId);
      expect(snap?.rootEnded).toBe(true);
      expect(snap?.rootEndTime).toBe(1767225613);

      // Run 2: a new processor resumes (a second turn arrives).
      await runThrough(
        [
          transcript({
            timestamp: "2026-01-01T00:00:20Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-2" },
          }),
          userMessage({ message: "again" }),
          taskComplete({ turn_id: "turn-2", last_agent_message: "ok" }),
          stop({ turn_id: "turn-2" }),
        ],
        deps,
      );

      const spans = await trace.drain();
      const tree = spansToTree(spans);
      // The root kept its original start (:10) and end (:13) — not corrupted to
      // the resume time, not left open.
      expect(tree?.metrics?.start).toBe(1767225610);
      expect(tree?.metrics?.end).toBe(1767225613);
      // The second turn still attached under the same root.
      expect(tree?.children.some((c) => c.name === "turn: turn-2")).toBe(true);
    } finally {
      trace.cleanup();
    }
  });

  // An OPEN span spanning the restart must keep its original start (the SDK would
  // otherwise stamp the rehydration time). Here the turn opens at :11 in run 1
  // and is closed in run 2.
  test("an open turn span keeps its original start across a restart", async () => {
    const trace = withCapturedTrace();
    try {
      const queueId = "sess-openstart";
      const reader = new FakeTranscriptReader();
      const store = new MemorySnapshotStore();
      const deps = { queueId, reader, factory: trace.spanFactory, store };

      await runThrough(
        [
          configEvent({ session_id: queueId }),
          transcript({
            timestamp: "2026-01-01T00:00:10Z",
            type: "session_meta",
            payload: { id: queueId, cwd: "/tmp/proj" },
          }),
          transcript({
            timestamp: "2026-01-01T00:00:11Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-1" },
          }),
          userMessage({ message: "hi" }),
          sessionStart({ session_id: queueId, source: "startup" }),
          preToolUse({ session_id: queueId }),
        ],
        deps,
      );

      await runThrough(
        [
          transcript({
            timestamp: "2026-01-01T00:00:30Z",
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "done" },
          }),
          stop({ turn_id: "turn-1" }),
        ],
        deps,
      );

      const tree = spansToTree(await trace.drain());
      const turn = tree?.children.find((c) => c.name === "turn: turn-1");
      // Start preserved from run 1 (:11), end from run 2 (:30) — not the resume time.
      expect(turn?.metrics?.start).toBe(1767225611);
      expect(turn?.metrics?.end).toBe(1767225630);
    } finally {
      trace.cleanup();
    }
  });
});
