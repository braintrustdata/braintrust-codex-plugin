// Processor for Codex events. A leading config event (same queueId) configures
// how this session reports to Braintrust (project/credentials), so the processor
// builds its own per-session SpanFactory. On SessionStart it opens a Braintrust
// root span. Each turn is a child span: UserPromptSubmit opens it (input = the
// user prompt), and the matching Stop closes it (output = the final assistant
// message). Tool calls are grandchild spans: PreToolUse opens a "tool" span under
// the matching turn (input = tool_input), and the matching PostToolUse (paired by
// tool_use_id) closes it (output = tool_response). The first Stop also ends the
// root span. Buffered spans are delivered via flush().

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

const SESSION_START = "SessionStart";
const USER_PROMPT_SUBMIT = "UserPromptSubmit";
const PRE_TOOL_USE = "PreToolUse";
const POST_TOOL_USE = "PostToolUse";
const STOP = "Stop";

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
  // UserPromptSubmit and closed (ended) by the matching Stop.
  private readonly openTurns = new Map<string, Span>();
  // Tool spans currently open, keyed by tool_use_id. A tool span is opened by
  // PreToolUse (as a child of its turn) and closed by the matching PostToolUse.
  // The owning turn_id is tracked so any still-open tool spans are ended when
  // their turn (or the root) ends.
  private readonly openTools = new Map<string, { span: Span; turnId: string }>();

  constructor(
    queueId: string | null,
    logger: Logger,
    spanFactoryProvider: SpanFactoryProvider = defaultSpanFactoryProvider,
  ) {
    this.queueId = queueId;
    this.logger = logger;
    this.spanFactoryProvider = spanFactoryProvider;
  }

  /** The session's SpanFactory, built from the config event on first use. */
  private get spanFactory(): SpanFactory {
    if (this.spanFactoryInstance === null) {
      this.spanFactoryInstance = this.spanFactoryProvider(this.reportingConfig, this.logger);
    }
    return this.spanFactoryInstance;
  }

  process(event: EnqueueEvent): void {
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
      this.startRootSpan(event);
      return;
    }
    if (event.eventName === USER_PROMPT_SUBMIT) {
      this.startTurnSpan(event);
      return;
    }
    if (event.eventName === PRE_TOOL_USE) {
      this.startToolSpan(event);
      return;
    }
    if (event.eventName === POST_TOOL_USE) {
      this.endToolSpan(event);
      return;
    }
    if (event.eventName === STOP) {
      this.endTurnSpan(event);
      this.endRootSpan();
      return;
    }
    // Other events will attach child spans to the root span in later phases.
    this.logger.debug("codex processor: no-op", {
      queueId: this.queueId,
      eventName: event.eventName,
    });
  }

  // Record the session's reporting config from the config event. The
  // SpanFactory is built lazily (on first span) from this config. Arriving
  // before the root span is created, this lets the session report to its own
  // project/account.
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

  /** Whether this session reports to Braintrust at all (master switch). */
  private get tracingEnabled(): boolean {
    return this.reportingConfig?.traceToBraintrust === true;
  }

  async flush(): Promise<void> {
    if (this.rootSpan === null) return;
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

  // Open a child span for a turn on UserPromptSubmit. Keyed by turn_id so the
  // matching Stop can close it. The user prompt is the span's input.
  private startTurnSpan(event: EnqueueEvent): void {
    if (this.rootSpan === null) {
      this.logger.warn("codex processor: turn without a root span; ignoring", {
        queueId: this.queueId,
      });
      return;
    }

    const data = (event.eventData ?? {}) as Record<string, unknown>;
    const turnId = typeof data.turn_id === "string" ? data.turn_id : undefined;
    const prompt = typeof data.prompt === "string" ? data.prompt : undefined;
    const model = typeof data.model === "string" ? data.model : undefined;

    if (turnId === undefined) {
      this.logger.warn("codex processor: UserPromptSubmit without turn_id; skipping turn span", {
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

    try {
      const turnSpan = this.rootSpan.startSpan({
        name: `turn: ${turnId}`,
        type: "task",
        event: {
          input: prompt,
          metadata: { turn_id: turnId, model },
        },
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

  // Open a child span for a tool call on PreToolUse, parented to the turn span
  // matching turn_id. Keyed by tool_use_id so the matching PostToolUse can close
  // it. The tool_input is the span's input. If the turn span isn't open (which
  // shouldn't happen — tool calls always occur within a turn) or there's no
  // tool_use_id to pair on, we log a warning and skip rather than guess a parent.
  private startToolSpan(event: EnqueueEvent): void {
    const data = (event.eventData ?? {}) as Record<string, unknown>;
    const turnId = typeof data.turn_id === "string" ? data.turn_id : undefined;
    const toolUseId = typeof data.tool_use_id === "string" ? data.tool_use_id : undefined;
    const toolName = typeof data.tool_name === "string" ? data.tool_name : undefined;
    const toolInput = data.tool_input;

    if (toolUseId === undefined) {
      this.logger.warn("codex processor: PreToolUse without tool_use_id; skipping tool span", {
        queueId: this.queueId,
        turnId,
      });
      return;
    }

    if (turnId === undefined) {
      this.logger.warn("codex processor: PreToolUse without turn_id; skipping tool span", {
        queueId: this.queueId,
        toolUseId,
      });
      return;
    }

    const turnSpan = this.openTurns.get(turnId);
    if (turnSpan === undefined) {
      this.logger.warn("codex processor: PreToolUse with no open turn span; skipping tool span", {
        queueId: this.queueId,
        turnId,
        toolUseId,
      });
      return;
    }

    if (this.openTools.has(toolUseId)) {
      this.logger.warn("codex processor: duplicate tool_use_id; keeping existing tool span", {
        queueId: this.queueId,
        toolUseId,
      });
      return;
    }

    try {
      const toolSpan = turnSpan.startSpan({
        name: toolName ?? "tool",
        type: "tool",
        event: {
          input: toolInput,
          metadata: { tool_name: toolName, tool_use_id: toolUseId, turn_id: turnId },
        },
      });
      this.openTools.set(toolUseId, { span: toolSpan, turnId });
      this.logger.info("codex processor: opened tool span", {
        queueId: this.queueId,
        turnId,
        toolUseId,
        spanId: toolSpan.id,
      });
    } catch (err) {
      this.logger.error("codex processor: failed to open tool span", {
        queueId: this.queueId,
        turnId,
        toolUseId,
        error: String(err),
      });
    }
  }

  // Close the tool span matching the PostToolUse's tool_use_id, recording the
  // tool_response as the span's output.
  private endToolSpan(event: EnqueueEvent): void {
    const data = (event.eventData ?? {}) as Record<string, unknown>;
    const toolUseId = typeof data.tool_use_id === "string" ? data.tool_use_id : undefined;
    const output = data.tool_response;

    if (toolUseId === undefined) {
      this.logger.debug("codex processor: PostToolUse without tool_use_id; no tool span to close", {
        queueId: this.queueId,
      });
      return;
    }

    const entry = this.openTools.get(toolUseId);
    if (entry === undefined) {
      this.logger.debug("codex processor: PostToolUse with no open tool span", {
        queueId: this.queueId,
        toolUseId,
      });
      return;
    }

    try {
      entry.span.log({ output });
      entry.span.end();
      this.logger.info("codex processor: ended tool span", { queueId: this.queueId, toolUseId });
    } catch (err) {
      this.logger.error("codex processor: failed to end tool span", {
        queueId: this.queueId,
        toolUseId,
        error: String(err),
      });
    } finally {
      this.openTools.delete(toolUseId);
    }
  }

  // End (without output) any still-open tool spans owned by the given turn. A
  // tool span can be left open when its PostToolUse never arrives (e.g. the call
  // was interrupted by a permission prompt and re-issued under a new
  // tool_use_id). Called when the turn ends so dangling tool spans get closed.
  private endOpenToolSpansForTurn(turnId: string): void {
    for (const [toolUseId, entry] of this.openTools) {
      if (entry.turnId !== turnId) continue;
      try {
        entry.span.end();
        this.logger.info("codex processor: ended dangling tool span on turn end", {
          queueId: this.queueId,
          turnId,
          toolUseId,
        });
      } catch (err) {
        this.logger.error("codex processor: failed to end dangling tool span", {
          queueId: this.queueId,
          turnId,
          toolUseId,
          error: String(err),
        });
      } finally {
        this.openTools.delete(toolUseId);
      }
    }
  }

  // Close the turn span matching the Stop's turn_id, recording the final
  // assistant message as the span's output.
  private endTurnSpan(event: EnqueueEvent): void {
    const data = (event.eventData ?? {}) as Record<string, unknown>;
    const turnId = typeof data.turn_id === "string" ? data.turn_id : undefined;
    const output =
      typeof data.last_assistant_message === "string" ? data.last_assistant_message : undefined;

    if (turnId === undefined) {
      this.logger.debug("codex processor: Stop without turn_id; no turn span to close", {
        queueId: this.queueId,
      });
      return;
    }

    const turnSpan = this.openTurns.get(turnId);
    if (turnSpan === undefined) {
      this.logger.debug("codex processor: Stop with no open turn span", {
        queueId: this.queueId,
        turnId,
      });
      return;
    }

    // Close any tool spans still open under this turn before ending the turn.
    this.endOpenToolSpansForTurn(turnId);

    try {
      turnSpan.log({ output });
      turnSpan.end();
      this.logger.info("codex processor: ended turn span", { queueId: this.queueId, turnId });
    } catch (err) {
      this.logger.error("codex processor: failed to end turn span", {
        queueId: this.queueId,
        turnId,
        error: String(err),
      });
    } finally {
      this.openTurns.delete(turnId);
    }
  }

  // End the root span on the first Stop event. Subsequent Stops are ignored
  // (the SDK keeps the first end time anyway).
  private endRootSpan(): void {
    if (this.rootSpan === null || this.rootEnded) return;
    this.rootEnded = true;
    // Backstop: close any tool spans still open (e.g. ones whose turn never saw
    // a matching Stop) so nothing is left dangling when the session ends.
    for (const [toolUseId, entry] of this.openTools) {
      try {
        entry.span.end();
      } catch (err) {
        this.logger.error("codex processor: failed to end dangling tool span on root end", {
          queueId: this.queueId,
          toolUseId,
          error: String(err),
        });
      }
    }
    this.openTools.clear();
    try {
      this.rootSpan.end();
      this.logger.info("codex processor: ended root span", { queueId: this.queueId });
    } catch (err) {
      this.logger.error("codex processor: failed to end root span", {
        queueId: this.queueId,
        error: String(err),
      });
    }
  }

  private startRootSpan(event: EnqueueEvent): void {
    if (this.rootSpan !== null) {
      this.logger.warn("codex processor: duplicate SessionStart; keeping existing root span", {
        queueId: this.queueId,
      });
      return;
    }

    const data = (event.eventData ?? {}) as Record<string, unknown>;
    const model = typeof data.model === "string" ? data.model : undefined;
    const cwd = typeof data.cwd === "string" ? data.cwd : undefined;
    const source = typeof data.source === "string" ? data.source : undefined;
    const permissionMode =
      typeof data.permission_mode === "string" ? data.permission_mode : undefined;

    // Name the root span after the directory Codex was launched from, e.g.
    // "codex: myapp" for /whatever/myapp. Falls back to "codex session" when cwd
    // is unknown.
    const projectDir = projectDirName(cwd);
    const spanName = projectDir ? `codex: ${projectDir}` : "codex session";

    try {
      this.rootSpan = this.spanFactory.startSpan({
        name: spanName,
        type: "task",
        event: {
          input: { model, cwd, source },
          metadata: {
            // User-provided extras first, so the standard keys below win on
            // conflict.
            ...this.reportingConfig?.additionalMetadata,
            session_id: this.queueId,
            model,
            cwd,
            source,
            permission_mode: permissionMode,
            event_source_version: event.eventSourceVersion,
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
}
