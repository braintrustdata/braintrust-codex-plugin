// Codex-specific test helpers. Spans are built from transcript records; hooks
// drive lifecycle (config, root enrichment, the Stop sentinel). A test expresses
// both sources in one ordered list. transcript(...) (and the typed builders that
// wrap it) represent lines being appended to the transcript file; hook builders
// (sessionStart, stop, configEvent) represent hook events arriving.
//
// Semantics: a transcript entry buffers a line. The NEXT hook triggers a
// catch-up that reads all buffered-but-unread lines, then handles the hook —
// modeling how the real processor catches up on each hook. A Stop hook waits for
// the turn's task_complete to be present before catching up.

import type { EnqueueEvent } from "../../server/routes.ts";
import {
  createTestLogger,
  diffSpan,
  type ExpectedSpan,
  spansToTree,
  withCapturedTrace,
} from "../../test-helpers.ts";
import { CODEX_CONFIG_EVENT } from "./event-builder.ts";
import { CodexEventProcessor } from "./event-processor.ts";
import type {
  TranscriptReader,
  TranscriptReadResult,
  TranscriptWaitResult,
  WaitForOptions,
} from "./transcript-reader.ts";

/** Synthetic transcript path attached to hook events so catch-up reads run. */
export const TEST_TRANSCRIPT_PATH = "/test/transcript.jsonl";

/** Monotonic default timestamp so transcript records sort in creation order. */
let tsCounter = 0;
function nextTimestamp(): string {
  tsCounter += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, tsCounter)).toISOString();
}

// ============================================================================
// Hook event builders
// ============================================================================

function codexHook(eventName: string, eventData: Record<string, unknown>): EnqueueEvent {
  const queueId = typeof eventData.session_id === "string" ? eventData.session_id : "session-1";
  return {
    queueId,
    eventSource: "codex-hook",
    eventSourceVersion: null,
    eventName,
    eventData: { hook_event_name: eventName, transcript_path: TEST_TRANSCRIPT_PATH, ...eventData },
  };
}

export function sessionStart(data: Record<string, unknown> = {}): EnqueueEvent {
  return codexHook("SessionStart", { session_id: "session-1", ...data });
}

export function stop(data: Record<string, unknown> = {}): EnqueueEvent {
  return codexHook("Stop", { session_id: "session-1", ...data });
}

/** A config event enabling tracing; pass extra reporting config via `data`. */
export function configEvent(data: Record<string, unknown> = {}): EnqueueEvent {
  return {
    queueId: typeof data.session_id === "string" ? data.session_id : "session-1",
    eventSource: "codex-hook",
    eventSourceVersion: null,
    eventName: CODEX_CONFIG_EVENT,
    eventData: { traceToBraintrust: true, ...data },
  };
}

// ============================================================================
// Transcript entry builders
// ============================================================================

/** Marks a transcript line being written to the (fake) transcript file. */
export interface TranscriptEntry {
  kind: "transcript";
  record: Record<string, unknown>;
}

/**
 * Build a raw transcript entry from a full record envelope
 * `{ timestamp, type, payload }`. `timestamp` defaults to a monotonic value.
 */
export function transcript(record: Record<string, unknown> = {}): TranscriptEntry {
  return {
    kind: "transcript",
    record: { timestamp: nextTimestamp(), ...record },
  };
}

/** session_meta record: opens the root span (cwd, session id, cli version). */
export function sessionMeta(payload: Record<string, unknown> = {}): TranscriptEntry {
  return transcript({ type: "session_meta", payload: { id: "session-1", ...payload } });
}

/** turn_context record: carries the model for a turn. */
export function turnContext(payload: Record<string, unknown> = {}): TranscriptEntry {
  return transcript({ type: "turn_context", payload });
}

/** task_started event: opens a turn span (by turn_id). */
export function taskStarted(payload: Record<string, unknown> = {}): TranscriptEntry {
  return transcript({ type: "event_msg", payload: { type: "task_started", ...payload } });
}

/** user_message event: the prompt; sets the open turn's input. */
export function userMessage(payload: Record<string, unknown> = {}): TranscriptEntry {
  return transcript({ type: "event_msg", payload: { type: "user_message", ...payload } });
}

/** task_complete event: closes a turn span (output = last_agent_message). */
export function taskComplete(payload: Record<string, unknown> = {}): TranscriptEntry {
  return transcript({ type: "event_msg", payload: { type: "task_complete", ...payload } });
}

/** function_call response_item: opens a tool span (by call_id, under turn). */
export function functionCall(payload: Record<string, unknown> = {}): TranscriptEntry {
  const { turn_id, metadata, ...rest } = payload as {
    turn_id?: string;
    metadata?: Record<string, unknown>;
  } & Record<string, unknown>;
  return transcript({
    type: "response_item",
    payload: {
      type: "function_call",
      ...(turn_id !== undefined ? { metadata: { turn_id, ...metadata } } : { metadata }),
      ...rest,
    },
  });
}

/** function_call_output response_item: closes a tool span (by call_id). */
export function functionCallOutput(payload: Record<string, unknown> = {}): TranscriptEntry {
  return transcript({
    type: "response_item",
    payload: { type: "function_call_output", ...payload },
  });
}

/** custom_tool_call response_item (e.g. apply_patch): opens a tool span. */
export function customToolCall(payload: Record<string, unknown> = {}): TranscriptEntry {
  const { turn_id, metadata, ...rest } = payload as {
    turn_id?: string;
    metadata?: Record<string, unknown>;
  } & Record<string, unknown>;
  return transcript({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      ...(turn_id !== undefined ? { metadata: { turn_id, ...metadata } } : { metadata }),
      ...rest,
    },
  });
}

/** custom_tool_call_output response_item: closes a tool span (by call_id). */
export function customToolCallOutput(payload: Record<string, unknown> = {}): TranscriptEntry {
  return transcript({
    type: "response_item",
    payload: { type: "custom_tool_call_output", ...payload },
  });
}

/** One entry in a mixed trace list: a hook event or a transcript write. */
export type TraceEntry = EnqueueEvent | TranscriptEntry;

function isTranscriptEntry(entry: TraceEntry): entry is TranscriptEntry {
  return (entry as TranscriptEntry).kind === "transcript";
}

// ============================================================================
// FakeTranscriptReader: an in-memory transcript fed by transcript(...) entries.
// ============================================================================

/**
 * Models the transcript file as a growing byte buffer. `append` writes a
 * complete line; `readFrom` returns complete lines from the given offset.
 * `waitFor` resolves immediately from the current buffer (the harness has
 * already written everything available before the hook runs), so tests stay
 * synchronous and don't actually sleep.
 */
export class FakeTranscriptReader implements TranscriptReader {
  private buffer = "";
  /** Offsets passed to readFrom/waitFor, in call order (for assertions). */
  readonly readOffsets: number[] = [];

  append(line: string): void {
    this.buffer += `${line}\n`;
  }

  readFrom(_path: string, offset: number): TranscriptReadResult {
    this.readOffsets.push(offset);
    const from = offset > this.buffer.length ? 0 : offset;
    const slice = this.buffer.slice(from);
    const lines: string[] = [];
    let consumed = 0;
    let lineStart = 0;
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === "\n") {
        lines.push(slice.slice(lineStart, i));
        lineStart = i + 1;
        consumed = lineStart;
      }
    }
    return { lines, offset: from + consumed };
  }

  async waitFor(
    path: string,
    offset: number,
    predicate: (line: string) => boolean,
    _opts: WaitForOptions,
  ): Promise<TranscriptWaitResult> {
    const { lines, offset: next } = this.readFrom(path, offset);
    const sentinelFound = lines.some(predicate);
    return { lines, offset: next, sentinelFound };
  }
}

// ============================================================================
// assertProducesTrace: run a mixed list of hook events and transcript writes
// through a CodexEventProcessor and assert the resulting trace.
// ============================================================================

export async function assertProducesTrace(
  entries: TraceEntry[],
  expected: ExpectedSpan,
  opts: { queueId?: string; reader?: FakeTranscriptReader } = {},
): Promise<void> {
  const hookEvents = entries.filter((e): e is EnqueueEvent => !isTranscriptEntry(e));
  const queueId = opts.queueId ?? hookEvents[0]?.queueId ?? "session-1";

  // Tracing is off by default; prepend a tracing-enabled config event unless the
  // caller already provided one, so trace assertions exercise the span path.
  const hasConfig = hookEvents.some((e) => e.eventName === CODEX_CONFIG_EVENT);
  const toRun: TraceEntry[] = hasConfig
    ? entries
    : [configEvent({ session_id: queueId }), ...entries];

  const reader = opts.reader ?? new FakeTranscriptReader();
  const trace = withCapturedTrace();
  try {
    const processor = new CodexEventProcessor(
      queueId,
      createTestLogger(),
      () => trace.spanFactory,
      reader,
    );
    for (const entry of toRun) {
      if (isTranscriptEntry(entry)) {
        reader.append(JSON.stringify(entry.record));
      } else {
        await processor.process(entry);
      }
    }
    await processor.flush();

    const tree = spansToTree(await trace.drain());
    const diffs = diffSpan(tree, expected, "root");
    if (diffs.length > 0) {
      throw new Error(`trace does not match expected:\n${diffs.join("\n")}`);
    }
  } finally {
    trace.cleanup();
  }
}
