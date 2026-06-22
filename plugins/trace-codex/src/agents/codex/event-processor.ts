// Processor for a single Codex session. Spans are built from the session
// transcript file (the "rollout"), which is the source of truth for everything
// inside a session: the root, each turn, and each tool call, in true execution
// order. The Codex lifecycle hooks drive when we read the transcript and supply
// a few fields the transcript lacks.
//
// Two ordered inputs:
//   - Hooks: `process(event)` is called once per hook. A leading config event
//     (same queueId) configures reporting. Each hook triggers a transcript
//     "catch-up". A SessionStart hook contributes `source`/`permission_mode` to
//     the root span (the transcript does not record these). A Stop hook is the
//     turn-terminal signal: before catching up we wait (bounded) for the turn's
//     `task_complete` to be written, so the final spans aren't truncated.
//   - Transcript: each new record is turned into spans by `processTranscriptEvent`:
//       session_meta   -> open the root span (start time = its timestamp)
//       task_started   -> open a turn span (child of root)
//       user_message   -> set the open turn's input (the prompt)
//       function_call / custom_tool_call / tool_search_call
//                      -> open a tool span (child of its turn), keyed by call_id
//       *_output       -> close the matching tool span (output)
//       task_complete  -> set the turn's output and close it
//
// Span start times come from transcript timestamps, so sibling spans (LLM and
// tool calls, later) render in execution order. Buffered spans are delivered via
// flush(). Everything is wrapped so tracing can never break a Codex turn.

import {
  defaultSpanFactoryProvider,
  type ReportingConfig,
  type Span,
  type SpanFactory,
  type SpanFactoryProvider,
} from "../../braintrust/logger.ts";
import type { Logger } from "../../log.ts";
import type { EventProcessor } from "../../processor/event-processor.ts";
import type { EnqueueEvent } from "../../server/routes.ts";
import { CODEX_CONFIG_EVENT } from "./event-builder.ts";
import {
  EVT_TASK_COMPLETE,
  EVT_TASK_STARTED,
  EVT_USER_MESSAGE,
  ITEM_CUSTOM_TOOL_CALL,
  ITEM_CUSTOM_TOOL_CALL_OUTPUT,
  ITEM_FUNCTION_CALL,
  ITEM_FUNCTION_CALL_OUTPUT,
  ITEM_TOOL_SEARCH_CALL,
  ITEM_TOOL_SEARCH_OUTPUT,
  parseTranscriptLine,
  RECORD_EVENT_MSG,
  RECORD_RESPONSE_ITEM,
  RECORD_SESSION_META,
  RECORD_TURN_CONTEXT,
  type TranscriptRecord,
} from "./transcript.ts";
import { defaultTranscriptReader, type TranscriptReader } from "./transcript-reader.ts";

const SESSION_START = "SessionStart";
const STOP = "Stop";

// Bound on how long a Stop hook waits for the turn's task_complete to appear in
// the transcript before giving up and emitting whatever exists. Codex can write
// task_complete several seconds after firing the Stop hook, so this is generous;
// the wait returns as soon as the sentinel is seen, and only the last turn of a
// session ever relies on it (earlier turns are closed by the next hook's
// catch-up). Still bounded so a stuck writer can never stall the Codex turn.
const SENTINEL_TIMEOUT_MS = 10_000;
const SENTINEL_INTERVAL_MS = 25;

// Bound on how long flush() polls the transcript for still-open turns to close
// (their task_complete can land seconds after the terminal Stop). flush() is off
// the Codex hot path, so this is generous; it returns immediately once no turns
// remain open, and is still bounded so a stuck writer can't hang shutdown.
const FLUSH_TIMEOUT_MS = 15_000;
const FLUSH_INTERVAL_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Tool-call response_item subtypes that OPEN a tool span. */
const TOOL_CALL_TYPES = new Set([ITEM_FUNCTION_CALL, ITEM_CUSTOM_TOOL_CALL, ITEM_TOOL_SEARCH_CALL]);
/** Tool-call response_item subtypes that CLOSE a tool span (by call_id). */
const TOOL_OUTPUT_TYPES = new Set([
  ITEM_FUNCTION_CALL_OUTPUT,
  ITEM_CUSTOM_TOOL_CALL_OUTPUT,
  ITEM_TOOL_SEARCH_OUTPUT,
]);

/**
 * The final path segment of `cwd`, used to name the root span (e.g.
 * "/whatever/myapp" -> "myapp"). Handles trailing separators and both POSIX and
 * Windows separators. Returns undefined when cwd is missing or has no usable
 * segment (e.g. "/").
 */
function projectDirName(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const segments = cwd.split(/[/\\]/).filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : undefined;
}

/** Parse an ISO timestamp to Unix seconds (Braintrust's start time unit). */
function isoToUnixSeconds(ts: unknown): number | undefined {
  if (typeof ts !== "string") return undefined;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms / 1000;
}

/** Extra root-span fields the transcript doesn't record; supplied by the hook. */
interface RootEnrichment {
  source?: string;
  permissionMode?: string;
}

export class CodexEventProcessor implements EventProcessor {
  private readonly logger: Logger;
  private readonly queueId: string | null;
  private readonly spanFactoryProvider: SpanFactoryProvider;
  /** Built lazily from the config event (or defaults) when first needed. */
  private spanFactoryInstance: SpanFactory | null = null;
  private reportingConfig: ReportingConfig | undefined;
  private rootSpan: Span | null = null;
  private rootEnded = false;
  // Turn spans currently open, keyed by turn_id. A turn is opened by
  // task_started and closed by the matching task_complete.
  private readonly openTurns = new Map<string, Span>();
  // turn_ids whose Stop hook has fired but whose task_complete hasn't been seen
  // yet (Codex can write task_complete seconds after the Stop hook). flush()
  // only blocks-and-polls when one of these is still open; a turn that is merely
  // mid-progress (no Stop yet) does not make an idle flush wait.
  private readonly turnsAwaitingCompletion = new Set<string>();
  // Tool spans currently open, keyed by call_id. Opened by a tool-call
  // response_item and closed by the matching *_output. The owning turn_id is
  // tracked so any still-open tool spans are ended when their turn ends.
  private readonly openTools = new Map<string, { span: Span; turnId: string }>();
  // Root enrichment from the SessionStart hook (source/permission_mode), which
  // the transcript lacks. Applied when the root span is created, or patched onto
  // the root if it already exists.
  private rootEnrichment: RootEnrichment = {};
  // Model slug, learned from the first turn_context (session_meta has none).
  private model: string | undefined;
  // End time (Unix seconds) of the most recently completed turn. Used to end the
  // root span at the right time when the session is finalized (on flush), since
  // Codex has no session-end hook and the SDK records a span's end time once.
  private lastTurnEndTime: number | undefined;
  // Reads new transcript content on each hook (the "catch-up").
  private readonly transcriptReader: TranscriptReader;
  // Byte offset into the transcript already consumed. In-memory only; if this
  // processor is evicted and recreated, the transcript is re-read from 0.
  private transcriptOffset = 0;
  // Transcript path from the latest hook, so flush() can do a final catch-up
  // (the last turn's task_complete can land just after its Stop hook fires).
  private transcriptPath: string | null = null;

  constructor(
    queueId: string | null,
    logger: Logger,
    spanFactoryProvider: SpanFactoryProvider = defaultSpanFactoryProvider,
    transcriptReader: TranscriptReader = defaultTranscriptReader,
  ) {
    this.queueId = queueId;
    this.logger = logger;
    this.spanFactoryProvider = spanFactoryProvider;
    this.transcriptReader = transcriptReader;
  }

  /** The session's SpanFactory, built from the config event on first use. */
  private get spanFactory(): SpanFactory {
    if (this.spanFactoryInstance === null) {
      this.spanFactoryInstance = this.spanFactoryProvider(this.reportingConfig, this.logger);
    }
    return this.spanFactoryInstance;
  }

  /** Whether this session reports to Braintrust at all (master switch). */
  private get tracingEnabled(): boolean {
    return this.reportingConfig?.traceToBraintrust === true;
  }

  // Dispatcher. The config event short-circuits (it configures reporting and
  // must run before any spans). Every other hook (a) records any hook-only data
  // it carries, (b) catches up the transcript into spans, and on Stop (c) ends
  // the root span. Wrapped so transcript work can never break the turn.
  async process(event: EnqueueEvent): Promise<void> {
    if (event.eventName === CODEX_CONFIG_EVENT) {
      this.configure(event);
      return;
    }
    // Master switch: when tracing is disabled, drop everything (no SDK calls).
    if (!this.tracingEnabled) {
      this.logger.debug("codex processor: tracing disabled; dropping event", {
        queueId: this.queueId,
        eventName: event.eventName,
      });
      return;
    }

    if (event.eventName === SESSION_START) {
      this.recordRootEnrichment(event);
    }

    // A Stop signals its turn is finishing; mark it so flush knows to wait for
    // this turn's task_complete (which Codex may write after the Stop hook).
    if (event.eventName === STOP) {
      const data = (event.eventData ?? {}) as Record<string, unknown>;
      const turnId = typeof data.turn_id === "string" ? data.turn_id : undefined;
      if (turnId !== undefined) this.turnsAwaitingCompletion.add(turnId);
    }

    try {
      await this.catchUpTranscript(event);
    } catch (err) {
      this.logger.error("codex processor: transcript catch-up failed", {
        queueId: this.queueId,
        eventName: event.eventName,
        error: String(err),
      });
    }

    // End the root span on the first Stop. The catch-up above has already
    // processed this turn's task_complete, so lastTurnEndTime is the turn's
    // completion time — used as the root's end time so it isn't stamped with a
    // late wall-clock value.
    if (event.eventName === STOP) {
      this.endRootSpan(this.lastTurnEndTime);
    }
  }

  // Read transcript lines appended since our last read and turn each into spans.
  // The transcript path comes from the hook payload. Never throws.
  //
  // On a Stop, first consume whatever's already on disk. If that closes the
  // turn, we're done. Otherwise Codex hasn't written this turn's task_complete
  // yet (it can lag the Stop hook by seconds), so wait (bounded) for it — but
  // only then, so a Stop whose turn is already complete returns immediately.
  private async catchUpTranscript(event: EnqueueEvent): Promise<void> {
    const data = (event.eventData ?? {}) as Record<string, unknown>;
    const path = typeof data.transcript_path === "string" ? data.transcript_path : undefined;
    if (path === undefined) return;
    this.transcriptPath = path;

    // Initial read of everything available now.
    const initial = this.transcriptReader.readFrom(path, this.transcriptOffset);
    this.transcriptOffset = initial.offset;
    this.consumeLines(initial.lines);

    if (event.eventName !== STOP) return;

    const turnId = typeof data.turn_id === "string" ? data.turn_id : undefined;
    // If the turn already closed during the initial read, no wait is needed.
    if (turnId === undefined || !this.openTurns.has(turnId)) return;

    // Wait (bounded) for this turn's task_complete to be written.
    const result = await this.transcriptReader.waitFor(
      path,
      this.transcriptOffset,
      (line) => this.isTaskCompleteFor(line, turnId),
      { timeoutMs: SENTINEL_TIMEOUT_MS, intervalMs: SENTINEL_INTERVAL_MS },
    );
    this.transcriptOffset = result.offset;
    this.consumeLines(result.lines);
    if (!result.sentinelFound) {
      this.logger.warn("codex processor: Stop sentinel not found; emitting partial turn", {
        queueId: this.queueId,
        turnId,
      });
    }
  }

  // Parse and process a batch of transcript lines into spans, advancing nothing
  // (the caller owns the offset). Used by catch-up and by the final flush read.
  private consumeLines(lines: string[]): void {
    for (const line of lines) {
      const record = parseTranscriptLine(line);
      if (record === null) continue;
      this.processTranscriptEvent(record);
    }
  }

  // Cheap check used as the Stop sentinel predicate: is this line a
  // task_complete for `turnId` (or any task_complete when turnId is unknown)?
  private isTaskCompleteFor(line: string, turnId: string | undefined): boolean {
    const record = parseTranscriptLine(line);
    if (record === null) return false;
    if (record.type !== RECORD_EVENT_MSG || record.payload?.type !== EVT_TASK_COMPLETE) {
      return false;
    }
    if (turnId === undefined) return true;
    return record.payload?.turn_id === turnId;
  }

  // Turn one parsed transcript record into span operations. Unknown record types
  // are ignored. Never throws; per-record failures are logged.
  private processTranscriptEvent(record: TranscriptRecord): void {
    try {
      if (record.type === RECORD_SESSION_META) {
        this.startRootSpan(record);
        return;
      }
      if (record.type === RECORD_TURN_CONTEXT) {
        this.noteModel(record);
        return;
      }
      if (record.type === RECORD_EVENT_MSG) {
        const ptype = record.payload?.type;
        if (ptype === EVT_TASK_STARTED) this.startTurnSpan(record);
        else if (ptype === EVT_USER_MESSAGE) this.setTurnInput(record);
        else if (ptype === EVT_TASK_COMPLETE) this.endTurnSpan(record);
        return;
      }
      if (record.type === RECORD_RESPONSE_ITEM) {
        const ptype = record.payload?.type ?? "";
        if (TOOL_CALL_TYPES.has(ptype)) this.startToolSpan(record);
        else if (TOOL_OUTPUT_TYPES.has(ptype)) this.endToolSpan(record);
        return;
      }
    } catch (err) {
      this.logger.error("codex processor: failed to process transcript record", {
        queueId: this.queueId,
        type: record.type,
        payloadType: record.payload?.type,
        error: String(err),
      });
    }
  }

  // ==========================================================================
  // Hook-driven configuration / enrichment
  // ==========================================================================

  // Record the session's reporting config from the config event. The
  // SpanFactory is built lazily (on first span) from this config.
  private configure(event: EnqueueEvent): void {
    if (this.spanFactoryInstance !== null) {
      this.logger.warn("codex processor: config event after factory built; ignoring", {
        queueId: this.queueId,
      });
      return;
    }
    const data = (event.eventData ?? {}) as Record<string, unknown>;
    this.reportingConfig = {
      project: typeof data.project === "string" ? data.project : undefined,
      apiKey: typeof data.apiKey === "string" ? data.apiKey : undefined,
      apiUrl: typeof data.apiUrl === "string" ? data.apiUrl : undefined,
      appUrl: typeof data.appUrl === "string" ? data.appUrl : undefined,
      traceToBraintrust: data.traceToBraintrust === true,
      additionalMetadata:
        typeof data.additionalMetadata === "object" &&
        data.additionalMetadata !== null &&
        !Array.isArray(data.additionalMetadata)
          ? (data.additionalMetadata as Record<string, unknown>)
          : undefined,
    };
    this.logger.info("codex processor: configured reporting", {
      queueId: this.queueId,
      project: this.reportingConfig.project,
      apiUrl: this.reportingConfig.apiUrl,
      hasApiKey: Boolean(this.reportingConfig.apiKey),
      traceToBraintrust: this.reportingConfig.traceToBraintrust,
    });
  }

  // Capture source/permission_mode from a SessionStart hook (the transcript
  // lacks these). If the root span already exists, patch them onto it now.
  private recordRootEnrichment(event: EnqueueEvent): void {
    const data = (event.eventData ?? {}) as Record<string, unknown>;
    const source = typeof data.source === "string" ? data.source : undefined;
    const permissionMode =
      typeof data.permission_mode === "string" ? data.permission_mode : undefined;
    if (source !== undefined) this.rootEnrichment.source = source;
    if (permissionMode !== undefined) this.rootEnrichment.permissionMode = permissionMode;

    if (this.rootSpan !== null) {
      try {
        this.rootSpan.log({
          metadata: { source: this.rootEnrichment.source, permission_mode: permissionMode },
        });
      } catch (err) {
        this.logger.error("codex processor: failed to enrich root span", {
          queueId: this.queueId,
          error: String(err),
        });
      }
    }
  }

  // ==========================================================================
  // Transcript-driven span building
  // ==========================================================================

  private startRootSpan(record: TranscriptRecord): void {
    if (this.rootSpan !== null) {
      this.logger.warn("codex processor: duplicate session_meta; keeping existing root span", {
        queueId: this.queueId,
      });
      return;
    }
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
    const sessionId = typeof payload.id === "string" ? payload.id : this.queueId;
    const startTime = isoToUnixSeconds(record.timestamp);

    const projectDir = projectDirName(cwd);
    const spanName = projectDir ? `codex: ${projectDir}` : "codex session";

    try {
      this.rootSpan = this.spanFactory.startSpan({
        name: spanName,
        type: "task",
        ...(startTime !== undefined ? { startTime } : {}),
        event: {
          input: { model: this.model, cwd, source: this.rootEnrichment.source },
          metadata: {
            // User-provided extras first, so the standard keys below win.
            ...this.reportingConfig?.additionalMetadata,
            session_id: sessionId,
            model: this.model,
            cwd,
            source: this.rootEnrichment.source,
            permission_mode: this.rootEnrichment.permissionMode,
            cli_version: typeof payload.cli_version === "string" ? payload.cli_version : undefined,
            project: this.reportingConfig?.project,
          },
        },
      });
      this.logger.info("codex processor: opened root span", {
        queueId: this.queueId,
        spanId: this.rootSpan.id,
      });
    } catch (err) {
      this.logger.error("codex processor: failed to open root span", {
        queueId: this.queueId,
        error: String(err),
      });
    }
  }

  // Learn the model from turn_context (session_meta has none). Backfill it onto
  // the root input/metadata the first time we see it.
  private noteModel(record: TranscriptRecord): void {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const model = typeof payload.model === "string" ? payload.model : undefined;
    if (model === undefined || this.model !== undefined) return;
    this.model = model;
    if (this.rootSpan !== null) {
      try {
        this.rootSpan.log({ input: { model }, metadata: { model } });
      } catch (err) {
        this.logger.error("codex processor: failed to backfill model on root", {
          queueId: this.queueId,
          error: String(err),
        });
      }
    }
  }

  // Open a turn span on task_started, child of the root, keyed by turn_id.
  private startTurnSpan(record: TranscriptRecord): void {
    if (this.rootSpan === null) {
      this.logger.warn("codex processor: task_started without a root span; ignoring", {
        queueId: this.queueId,
      });
      return;
    }
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
    if (turnId === undefined) {
      this.logger.warn("codex processor: task_started without turn_id; skipping turn span", {
        queueId: this.queueId,
      });
      return;
    }
    if (this.openTurns.has(turnId)) {
      this.logger.warn("codex processor: duplicate turn_id; keeping existing turn span", {
        queueId: this.queueId,
        turnId,
      });
      return;
    }
    const startTime = isoToUnixSeconds(record.timestamp);
    try {
      const turnSpan = this.rootSpan.startSpan({
        name: `turn: ${turnId}`,
        type: "task",
        ...(startTime !== undefined ? { startTime } : {}),
        event: { metadata: { turn_id: turnId, model: this.model } },
      });
      this.openTurns.set(turnId, turnSpan);
      this.logger.info("codex processor: opened turn span", {
        queueId: this.queueId,
        turnId,
        spanId: turnSpan.id,
      });
    } catch (err) {
      this.logger.error("codex processor: failed to open turn span", {
        queueId: this.queueId,
        turnId,
        error: String(err),
      });
    }
  }

  // Set the open turn's input from a user_message event (the prompt). The
  // user_message carries no turn_id, so it applies to the most recently opened
  // still-open turn.
  private setTurnInput(record: TranscriptRecord): void {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const prompt = typeof payload.message === "string" ? payload.message : undefined;
    if (prompt === undefined) return;
    const turnSpan = this.latestOpenTurn();
    if (turnSpan === undefined) {
      this.logger.debug("codex processor: user_message with no open turn span", {
        queueId: this.queueId,
      });
      return;
    }
    try {
      turnSpan.log({ input: prompt });
    } catch (err) {
      this.logger.error("codex processor: failed to set turn input", {
        queueId: this.queueId,
        error: String(err),
      });
    }
  }

  // Close the turn span on task_complete, recording the final assistant message
  // as output. Also closes any tool spans still open under that turn.
  private endTurnSpan(record: TranscriptRecord): void {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
    const output =
      typeof payload.last_agent_message === "string" ? payload.last_agent_message : undefined;
    if (turnId === undefined) {
      this.logger.debug("codex processor: task_complete without turn_id", {
        queueId: this.queueId,
      });
      return;
    }
    const turnSpan = this.openTurns.get(turnId);
    if (turnSpan === undefined) {
      this.logger.debug("codex processor: task_complete with no open turn span", {
        queueId: this.queueId,
        turnId,
      });
      return;
    }
    const endTime = isoToUnixSeconds(record.timestamp);
    this.endOpenToolSpansForTurn(turnId, endTime);
    try {
      turnSpan.log({ output });
      turnSpan.end(endTime !== undefined ? { endTime } : undefined);
      if (endTime !== undefined) this.lastTurnEndTime = endTime;
      this.logger.info("codex processor: ended turn span", { queueId: this.queueId, turnId });
    } catch (err) {
      this.logger.error("codex processor: failed to end turn span", {
        queueId: this.queueId,
        turnId,
        error: String(err),
      });
    } finally {
      this.openTurns.delete(turnId);
      this.turnsAwaitingCompletion.delete(turnId);
    }
  }

  // Open a tool span (child of its turn) for a tool-call response_item. Keyed by
  // call_id so the matching *_output can close it. Skipped (with a warning) when
  // there's no call_id or no open turn for its metadata.turn_id.
  private startToolSpan(record: TranscriptRecord): void {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
    const name = typeof payload.name === "string" ? payload.name : undefined;
    const meta = (payload.metadata ?? {}) as Record<string, unknown>;
    const turnId = typeof meta.turn_id === "string" ? meta.turn_id : undefined;
    // function_call uses `arguments` (a JSON string); custom_tool_call uses `input`.
    const input = payload.arguments ?? payload.input;

    if (callId === undefined) {
      this.logger.warn("codex processor: tool call without call_id; skipping tool span", {
        queueId: this.queueId,
        turnId,
      });
      return;
    }
    if (turnId === undefined) {
      this.logger.warn("codex processor: tool call without turn_id; skipping tool span", {
        queueId: this.queueId,
        callId,
      });
      return;
    }
    const turnSpan = this.openTurns.get(turnId);
    if (turnSpan === undefined) {
      this.logger.warn("codex processor: tool call with no open turn span; skipping", {
        queueId: this.queueId,
        turnId,
        callId,
      });
      return;
    }
    if (this.openTools.has(callId)) {
      this.logger.warn("codex processor: duplicate call_id; keeping existing tool span", {
        queueId: this.queueId,
        callId,
      });
      return;
    }
    const startTime = isoToUnixSeconds(record.timestamp);
    try {
      const toolSpan = turnSpan.startSpan({
        name: name ?? "tool",
        type: "tool",
        ...(startTime !== undefined ? { startTime } : {}),
        event: {
          input,
          metadata: { tool_name: name, call_id: callId, turn_id: turnId },
        },
      });
      this.openTools.set(callId, { span: toolSpan, turnId });
      this.logger.info("codex processor: opened tool span", {
        queueId: this.queueId,
        turnId,
        callId,
        spanId: toolSpan.id,
      });
    } catch (err) {
      this.logger.error("codex processor: failed to open tool span", {
        queueId: this.queueId,
        turnId,
        callId,
        error: String(err),
      });
    }
  }

  // Close the tool span matching a *_output record's call_id, recording the
  // output.
  private endToolSpan(record: TranscriptRecord): void {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
    const output = payload.output ?? payload.result;
    if (callId === undefined) {
      this.logger.debug("codex processor: tool output without call_id", {
        queueId: this.queueId,
      });
      return;
    }
    const entry = this.openTools.get(callId);
    if (entry === undefined) {
      this.logger.debug("codex processor: tool output with no open tool span", {
        queueId: this.queueId,
        callId,
      });
      return;
    }
    const endTime = isoToUnixSeconds(record.timestamp);
    try {
      entry.span.log({ output });
      entry.span.end(endTime !== undefined ? { endTime } : undefined);
      this.logger.info("codex processor: ended tool span", { queueId: this.queueId, callId });
    } catch (err) {
      this.logger.error("codex processor: failed to end tool span", {
        queueId: this.queueId,
        callId,
        error: String(err),
      });
    } finally {
      this.openTools.delete(callId);
    }
  }

  // End any still-open tool spans owned by the given turn (e.g. a call whose
  // output never arrived) when the turn ends. Uses the turn's end time so a
  // dangling tool span doesn't get a wall-clock end far in the future.
  private endOpenToolSpansForTurn(turnId: string, endTime: number | undefined): void {
    for (const [callId, entry] of this.openTools) {
      if (entry.turnId !== turnId) continue;
      try {
        entry.span.end(endTime !== undefined ? { endTime } : undefined);
        this.logger.info("codex processor: ended dangling tool span on turn end", {
          queueId: this.queueId,
          turnId,
          callId,
        });
      } catch (err) {
        this.logger.error("codex processor: failed to end dangling tool span", {
          queueId: this.queueId,
          turnId,
          callId,
          error: String(err),
        });
      } finally {
        this.openTools.delete(callId);
      }
    }
  }

  // The most recently opened turn that is still open (used to attach a
  // user_message, which carries no turn_id).
  private latestOpenTurn(): Span | undefined {
    let last: Span | undefined;
    for (const span of this.openTurns.values()) last = span;
    return last;
  }

  // Number of turns whose Stop has fired but which are still open (awaiting
  // their task_complete). flush() polls only while this is > 0.
  private countPendingTurns(): number {
    let n = 0;
    for (const turnId of this.turnsAwaitingCompletion) {
      if (this.openTurns.has(turnId)) n += 1;
    }
    return n;
  }

  // End the root span on the first Stop hook. Subsequent Stops are ignored
  // (the SDK records a span's end time once). `endTime` is the completing turn's
  // end time so the root isn't stamped with a late wall-clock value; falls back
  // to the SDK's now() if unknown. Any still-open turn/tool spans are closed at
  // the same time so nothing dangles.
  private endRootSpan(endTime: number | undefined): void {
    if (this.rootSpan === null || this.rootEnded) return;
    this.rootEnded = true;
    const endArgs = endTime !== undefined ? { endTime } : undefined;
    // Backstop: close any spans still open so nothing dangles.
    for (const [callId, entry] of this.openTools) {
      try {
        entry.span.end(endArgs);
      } catch (err) {
        this.logger.error("codex processor: failed to end dangling tool span on root end", {
          queueId: this.queueId,
          callId,
          error: String(err),
        });
      }
    }
    this.openTools.clear();
    for (const [turnId, span] of this.openTurns) {
      try {
        span.end(endArgs);
      } catch (err) {
        this.logger.error("codex processor: failed to end dangling turn span on root end", {
          queueId: this.queueId,
          turnId,
          error: String(err),
        });
      }
    }
    this.openTurns.clear();
    try {
      this.rootSpan.end(endArgs);
      this.logger.info("codex processor: ended root span", { queueId: this.queueId });
    } catch (err) {
      this.logger.error("codex processor: failed to end root span", {
        queueId: this.queueId,
        error: String(err),
      });
    }
  }

  async flush(): Promise<void> {
    if (this.rootSpan === null) return;
    // Final catch-up: a turn's task_complete can land slightly after its Stop
    // hook fires, so the Stop's bounded wait may miss it and leave the turn open.
    // flush() happens after the terminal Stop's /flush (and on idle/eviction).
    // Poll the transcript until every open turn has closed (or a bounded timeout
    // elapses), processing new records as they appear. This processes the
    // transcript (it does not unilaterally end spans), staying consistent with
    // "the transcript is the truth".
    await this.drainOpenTurns();
    try {
      await this.rootSpan.flush();
      this.logger.debug("codex processor: flush ok", { queueId: this.queueId });
    } catch (err) {
      this.logger.error("codex processor: flush failed", {
        queueId: this.queueId,
        error: String(err),
      });
    }
  }

  // Read and process new transcript records, retrying on a bounded interval,
  // until no turn that has seen its Stop is still open (its task_complete can
  // land seconds after the Stop hook) or the timeout elapses. Always does at
  // least one read so a task_complete already on disk closes its turn
  // immediately. Crucially, this does NOT wait for turns that are merely
  // mid-progress (no Stop yet) — so an idle flush during an active turn returns
  // promptly instead of blocking. On timeout, leaves whatever is still open for
  // endRootSpan's backstop to close.
  private async drainOpenTurns(): Promise<void> {
    if (this.transcriptPath === null) return;
    const deadline = Date.now() + FLUSH_TIMEOUT_MS;
    for (;;) {
      try {
        const { lines, offset } = this.transcriptReader.readFrom(
          this.transcriptPath,
          this.transcriptOffset,
        );
        this.transcriptOffset = offset;
        this.consumeLines(lines);
      } catch (err) {
        this.logger.error("codex processor: final catch-up read failed", {
          queueId: this.queueId,
          error: String(err),
        });
        return;
      }
      // Only turns whose Stop has fired but whose task_complete hasn't arrived
      // keep us waiting. (endTurnSpan removes them from both sets as they close.)
      const pending = this.countPendingTurns();
      if (pending === 0 || Date.now() >= deadline) {
        if (pending > 0) {
          this.logger.warn("codex processor: turns awaiting completion at flush timeout", {
            queueId: this.queueId,
            pending,
          });
        }
        return;
      }
      await sleep(FLUSH_INTERVAL_MS);
    }
  }
}
