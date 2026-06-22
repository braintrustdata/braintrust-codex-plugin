// Codex-specific test helpers: event builders that mimic Codex hook payloads,
// and assertProducesTrace, which runs events through the CodexEventProcessor and
// checks the resulting Braintrust trace. Generic trace/span helpers are imported
// from the shared test-helpers.

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

// ============================================================================
// Event builders
// ============================================================================

function codexEvent(eventName: string, eventData: Record<string, unknown>): EnqueueEvent {
  const queueId = typeof eventData.session_id === "string" ? eventData.session_id : "session-1";
  return {
    queueId,
    eventSource: "codex-hook",
    eventSourceVersion: null,
    eventName,
    eventData: { hook_event_name: eventName, ...eventData },
  };
}

export function sessionStart(data: Record<string, unknown> = {}): EnqueueEvent {
  return codexEvent("SessionStart", { session_id: "session-1", ...data });
}

export function userPromptSubmit(data: Record<string, unknown> = {}): EnqueueEvent {
  return codexEvent("UserPromptSubmit", { session_id: "session-1", ...data });
}

export function preToolUse(data: Record<string, unknown> = {}): EnqueueEvent {
  return codexEvent("PreToolUse", { session_id: "session-1", ...data });
}

export function postToolUse(data: Record<string, unknown> = {}): EnqueueEvent {
  return codexEvent("PostToolUse", { session_id: "session-1", ...data });
}

export function stop(data: Record<string, unknown> = {}): EnqueueEvent {
  return codexEvent("Stop", { session_id: "session-1", ...data });
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
// assertProducesTrace: run events through a CodexEventProcessor and assert the
// resulting trace. One session => one trace.
// ============================================================================

export async function assertProducesTrace(
  events: EnqueueEvent[],
  expected: ExpectedSpan,
  opts: { queueId?: string } = {},
): Promise<void> {
  const queueId = opts.queueId ?? events[0]?.queueId ?? "session-1";
  // Tracing is off by default; prepend a tracing-enabled config event unless the
  // caller already provided one, so trace assertions exercise the span path.
  const hasConfig = events.some((e) => e.eventName === CODEX_CONFIG_EVENT);
  const toProcess = hasConfig ? events : [configEvent({ session_id: queueId }), ...events];
  const trace = withCapturedTrace();
  try {
    const processor = new CodexEventProcessor(queueId, createTestLogger(), () => trace.spanFactory);
    for (const event of toProcess) {
      await processor.process(event);
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
