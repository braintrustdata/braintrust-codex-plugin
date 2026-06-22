// Resume / state-persistence tests.
//
// When the event server shuts down mid-session (idle timeout) or the user closes
// and later resumes, a fresh CodexEventProcessor is created for the same session
// id. These tests verify that, given a persisted snapshot, the new processor
// rehydrates the original spans and continues the SAME trace — producing the
// same result as if one processor had handled the whole session — instead of
// duplicating or orphaning spans.

import { describe, expect, test } from "bun:test";
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
  type transcript,
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
        rootEnrichment: {},
        mainScopePath: "/old.jsonl",
        scopes: [],
        spawnTurnSpansByCallId: [],
        spawnTurnSpansByAgentId: [],
        compactionTriggerByTurn: [],
        compactionSpansByTurn: [],
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
});
