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

import { basename, dirname } from "node:path";

import {
  defaultSpanFactoryProvider,
  type ReportingConfig,
  type Span,
  type SpanFactory,
  type SpanFactoryProvider,
  type SpanRef,
  spanRef,
} from "../../braintrust/logger.ts";
import { gitMetadataForCwd } from "../../git-metadata.ts";
import type { Logger } from "../../log.ts";
import type { EventProcessor } from "../../processor/event-processor.ts";
import type { EnqueueEvent } from "../../server/routes.ts";
import { PLUGIN_VERSION } from "../../version.ts";
import { CODEX_CONFIG_EVENT } from "./event-builder.ts";
import type { SnapshotStore } from "./snapshot-store.ts";
import {
  type CodexSnapshot,
  type ConversationItemSnapshot,
  isCompatibleSnapshot,
  redactReportingConfig,
  type ScopeSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
} from "./state-snapshot.ts";
import {
  EVT_TASK_COMPLETE,
  EVT_TASK_STARTED,
  EVT_TOKEN_COUNT,
  EVT_USER_MESSAGE,
  ITEM_CUSTOM_TOOL_CALL,
  ITEM_CUSTOM_TOOL_CALL_OUTPUT,
  ITEM_FUNCTION_CALL,
  ITEM_FUNCTION_CALL_OUTPUT,
  ITEM_MESSAGE,
  ITEM_REASONING,
  ITEM_TOOL_SEARCH_CALL,
  ITEM_TOOL_SEARCH_OUTPUT,
  parseTranscriptLine,
  RECORD_COMPACTED,
  RECORD_EVENT_MSG,
  RECORD_RESPONSE_ITEM,
  RECORD_SESSION_META,
  RECORD_TURN_CONTEXT,
  type TranscriptRecord,
} from "./transcript.ts";
import { defaultTranscriptReader, type TranscriptReader } from "./transcript-reader.ts";

const SESSION_START = "SessionStart";
const STOP = "Stop";
const SUBAGENT_START = "SubagentStart";
const SUBAGENT_STOP = "SubagentStop";
const POST_TOOL_USE = "PostToolUse";
const PRE_COMPACT = "PreCompact";
const POST_COMPACT = "PostCompact";
const SPAWN_AGENT_TOOL = "spawn_agent";
const MISSING_TOOL_OUTPUT_ERROR = "Tool output missing before turn ended";
// Tag applied to a tool span whose call requested escalated permissions, so
// permission-gated actions are easy to find/filter in Braintrust.
const PERMISSION_TAG = "permission-request";
// Tag applied to a turn span that performed a context compaction, so compactions
// are easy to find/filter in Braintrust.
const COMPACTION_TAG = "compaction";

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

/**
 * Whether a hook signals the end of a turn (so we should wait, bounded, for the
 * turn's task_complete to be written). Stop ends a normal turn; SubagentStop a
 * subagent turn; PostCompact a compaction turn — which, unlike the others, never
 * gets a Stop, so this is what lets its span close promptly instead of lingering
 * open until idle eviction.
 */
function isTurnTerminal(eventName: string): boolean {
  return eventName === STOP || eventName === SUBAGENT_STOP || eventName === POST_COMPACT;
}

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

/**
 * An OpenAI-style chat message. Used to reconstruct each LLM call's input (the
 * transcript does not log the literal request) and to shape its output, so
 * Braintrust renders these spans as proper LLM calls. Tool calls become an
 * assistant message with `tool_calls`; tool results become a `tool` message.
 */
interface ChatMessage {
  role: "developer" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * A reasoning ("thinking") item, in the OpenAI Responses shape Braintrust
 * renders. `summary` is the readable reasoning text the model exposes (Codex
 * records it on `reasoning` transcript items as `summary_text` entries; the full
 * chain-of-thought itself is encrypted and not available). Interleaved with chat
 * messages in an LLM call's output and in the conversation history.
 */
interface ReasoningItem {
  type: "reasoning";
  summary: Array<{ type: "summary_text"; text: string }>;
}

/** An item in an LLM call's output or the conversation history. */
type ConversationItem = ChatMessage | ReasoningItem;

/** State for the LLM span currently in progress (one model call). */
interface OpenLlm {
  span: Span;
  turnId: string | undefined;
  /** Items produced by this call: reasoning, assistant text, and/or tool calls. */
  output: ConversationItem[];
  /**
   * Timestamp (Unix seconds) of this call's last model-output item (message /
   * reasoning / tool call). This is when the model finished generating and is
   * used as the span's end time — NOT the closing token_count's timestamp. Codex
   * writes the token_count after the tool result (at the same instant as the
   * tool output), so ending the span there would wrongly stretch it to swallow
   * the tool's execution. The token_count only supplies token metrics.
   */
  lastOutputTime: number | undefined;
  /**
   * When true, the span's output was already set at creation (e.g. a compaction
   * call, whose output is the replacement history), so closing it must not
   * overwrite it with the accumulated `output` messages.
   */
  outputPreset?: boolean;
}

/**
 * An open turn span plus the timing we need to place its child LLM spans. The
 * transcript records a model call's output only when it lands (just before the
 * call's token_count), with no record at request-send time — so an LLM span
 * stamped from its first output item would look near-instant. Instead we start
 * each LLM span at the end of the most recently-ended child of this turn
 * (`lastChildEndTime`), or at the turn's own start (`startTime`) when it's the
 * first child. That makes a call's span cover request→response, and consecutive
 * children tile the turn. All per-turn (hence per-scope), so concurrent
 * subagents never affect each other's timing.
 */
interface OpenTurn {
  span: Span;
  /** Turn start (Unix seconds), used as the first child's start time. */
  startTime: number | undefined;
  /** Max end time (Unix seconds) among this turn's already-ended children. */
  lastChildEndTime: number | undefined;
  /** Explicit skill names requested by the user for this turn. */
  explicitSkillNames: string[];
}

/**
 * All parsing state tied to a single transcript file. The main session has one
 * scope (its parent is the root span); each subagent gets its own scope (its
 * parent is the subagent root span, a child of the spawn_agent tool that created
 * it). Keeping offset + open spans per file is essential: a session and its
 * subagents are interleaved on one hook stream but write to separate transcript
 * files, so a single shared offset would read the wrong file's bytes.
 */
interface TranscriptScope {
  /** Absolute transcript path this scope reads from. */
  readonly path: string;
  /** "main" session vs. a spawned subagent. */
  readonly kind: "main" | "subagent";
  /**
   * Parent span for this scope's turn spans. For the main scope this is the
   * root span; for a subagent it is the subagent root span. Resolved lazily so a
   * subagent scope can be registered before its parent span is built.
   */
  readonly parentSpan: () => Span | null;
  /** Byte offset already consumed from `path`. */
  offset: number;
  /** Turn spans currently open in this scope, keyed by turn_id (with the timing
   * used to place their child LLM spans). */
  readonly openTurns: Map<string, OpenTurn>;
  /** turn_ids whose Stop has fired but whose task_complete hasn't been seen. */
  readonly turnsAwaitingCompletion: Set<string>;
  /** OpenAI-style chat history (messages + reasoning), used to reconstruct each
   * LLM call's input. */
  readonly conversationHistory: ConversationItem[];
  /** The currently-open LLM span in this scope, if a model call is in progress. */
  openLlm: OpenLlm | null;
  /** Tool spans currently open in this scope, keyed by call_id. */
  readonly openTools: Map<string, { span: Span; turnId: string }>;
  /** Model slug, learned from this scope's first turn_context. */
  model: string | undefined;
  /** End time (Unix seconds) of the most recently completed turn in this scope. */
  lastTurnEndTime: number | undefined;
  /**
   * For a subagent scope: its root span (the span the subagent's turns hang
   * under) and whether it has been ended. Null/false for the main scope, which
   * uses the processor's root span instead. The root span is created lazily from
   * the subagent's own session_meta record (so it gets a real start time);
   * `pendingSubagent` holds what's needed to create it until then.
   */
  subagentRootSpan: Span | null;
  subagentEnded: boolean;
  pendingSubagent?: { agentId: string; agentType: string | undefined; parent: Span };
}

/** Map Codex token usage keys onto Braintrust's standard metric names. */
function tokenMetrics(usage: Record<string, unknown>): Record<string, number> {
  const metrics: Record<string, number> = {};
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const at = (path: string): number | undefined => {
    let cur: unknown = usage;
    for (const part of path.split(".")) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return num(cur);
  };
  const map: Array<[string, string]> = [
    ["input_tokens", "prompt_tokens"],
    ["prompt_tokens", "prompt_tokens"],
    ["output_tokens", "completion_tokens"],
    ["completion_tokens", "completion_tokens"],
    ["total_tokens", "tokens"],
    ["tokens", "tokens"],
    ["cached_input_tokens", "prompt_cached_tokens"],
    ["prompt_cached_tokens", "prompt_cached_tokens"],
    ["input_tokens_details.cached_tokens", "prompt_cached_tokens"],
    ["prompt_tokens_details.cached_tokens", "prompt_cached_tokens"],
    ["prompt_cache_creation_tokens", "prompt_cache_creation_tokens"],
    ["input_tokens_details.cache_creation_tokens", "prompt_cache_creation_tokens"],
    ["input_tokens_details.cache_write_tokens", "prompt_cache_creation_tokens"],
    ["prompt_tokens_details.cache_creation_tokens", "prompt_cache_creation_tokens"],
    ["prompt_tokens_details.cache_write_tokens", "prompt_cache_creation_tokens"],
    ["reasoning_output_tokens", "completion_reasoning_tokens"],
    ["completion_reasoning_tokens", "completion_reasoning_tokens"],
    ["reasoning_tokens", "completion_reasoning_tokens"],
    ["output_tokens_details.reasoning_tokens", "completion_reasoning_tokens"],
    ["completion_tokens_details.reasoning_tokens", "completion_reasoning_tokens"],
    ["cost", "cost"],
    ["cost", "estimated_cost"],
    ["estimated_cost", "estimated_cost"],
    ["total_cost", "estimated_cost"],
    ["cost_usd", "estimated_cost"],
  ];
  for (const [from, to] of map) {
    if (metrics[to] !== undefined) continue;
    const v = at(from);
    if (v !== undefined) metrics[to] = v;
  }
  if (
    metrics.tokens === undefined &&
    metrics.prompt_tokens !== undefined &&
    metrics.completion_tokens !== undefined
  ) {
    metrics.tokens = metrics.prompt_tokens + metrics.completion_tokens;
  }
  return metrics;
}

/**
 * Shape an LLM call's output for Braintrust. Braintrust renders a single
 * assistant message or an array of messages as a chat completion; a single
 * message is returned directly, multiple are returned as an array.
 */
function llmOutput(messages: ConversationItem[]): unknown {
  if (messages.length === 1) return messages[0];
  return messages;
}

/**
 * Extract the readable reasoning summary from a `reasoning` item's `summary`
 * field: a list of `{type: "summary_text", text}` entries. Returns the
 * non-empty entries (matching Braintrust's reasoning shape), or undefined when
 * there's nothing readable (the full reasoning is encrypted and not exposed).
 */
function reasoningSummary(
  summary: unknown,
): Array<{ type: "summary_text"; text: string }> | undefined {
  if (!Array.isArray(summary)) return undefined;
  const parts: Array<{ type: "summary_text"; text: string }> = [];
  for (const entry of summary) {
    if (entry && typeof entry === "object") {
      const text = (entry as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) {
        parts.push({ type: "summary_text", text });
      }
    }
  }
  return parts.length > 0 ? parts : undefined;
}

/** Extract the concatenated text from a response_item message's content array. */
function messageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

/**
 * Shape a compaction's `replacement_history` into a readable "after compaction"
 * output. The replacement history is the new context Codex keeps going forward:
 * a few recent messages kept verbatim, plus a `compaction` entry holding the
 * summary as `encrypted_content` (opaque to us). We surface the readable kept
 * messages and replace the encrypted summary with a clear marker, so the span
 * doesn't look like the model merely echoed the last user message.
 */
function compactionOutput(replacement: unknown[] | undefined): Record<string, unknown> {
  if (replacement === undefined) {
    return { summary: "[unavailable]", kept_messages: [] };
  }
  const kept: unknown[] = [];
  let summaryEncrypted = false;
  for (const entry of replacement) {
    if (entry !== null && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      if (e.type === "compaction") {
        if (typeof e.encrypted_content === "string") summaryEncrypted = true;
        continue;
      }
    }
    kept.push(entry);
  }
  return {
    summary: summaryEncrypted ? "[summary unavailable — encrypted by Codex]" : "[no summary]",
    kept_messages: kept,
  };
}

/** A tool call's permission/escalation request, parsed from its arguments. */
interface PermissionInfo {
  /** The requested sandbox permission, e.g. "require_escalated". */
  sandbox_permissions: string;
  /** The model's justification shown to the user (may be absent). */
  justification?: string;
  /** The command prefix the escalation applies to (may be absent). */
  prefix_rule?: unknown;
}

interface SkillLoadInfo {
  skillName?: string;
  skillPath?: string;
}

interface ExplicitSkillRequestMetadata extends Record<string, unknown> {
  loaded_skill_names: string[];
  loaded_skills: Array<{ name: string }>;
}

/**
 * Parse a tool call's permission/escalation request from its arguments. Codex
 * records an escalated retry's request inline in the function_call arguments
 * (`sandbox_permissions`, `justification`, `prefix_rule`); when present, we
 * surface it on the tool span. `args` is the raw arguments (a JSON string for
 * function_call, or an object for custom_tool_call). Returns undefined when
 * there's no escalation request.
 */
function permissionInfo(args: unknown): PermissionInfo | undefined {
  let obj: Record<string, unknown> | undefined;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed !== null && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  } else if (args !== null && typeof args === "object") {
    obj = args as Record<string, unknown>;
  }
  if (obj === undefined) return undefined;
  const sandbox = obj.sandbox_permissions;
  if (typeof sandbox !== "string" || sandbox.length === 0) return undefined;
  const info: PermissionInfo = { sandbox_permissions: sandbox };
  if (typeof obj.justification === "string") info.justification = obj.justification;
  if (obj.prefix_rule !== undefined) info.prefix_rule = obj.prefix_rule;
  return info;
}

function parseArgsObject(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      return parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  return args !== null && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
}

function stringCandidates(args: unknown): string[] {
  const candidates: string[] = [];
  if (typeof args === "string") candidates.push(args);
  const obj = parseArgsObject(args);
  if (obj !== undefined) {
    for (const key of ["path", "file_path", "filePath", "file", "command", "cmd", "resource"]) {
      const value = obj[key];
      if (typeof value === "string") candidates.push(value);
    }
  }
  return candidates;
}

function normalizeExplicitSkillName(name: string): string | undefined {
  const normalized = name
    .trim()
    .replace(/^\$+/, "")
    .replace(/[),.;]+$/, "");
  return normalized ? normalized : undefined;
}

function explicitSkillRequestMetadata(
  names: readonly string[],
): ExplicitSkillRequestMetadata | undefined {
  const seen = new Set<string>();
  const loaded_skill_names: string[] = [];
  for (const name of names) {
    const normalized = normalizeExplicitSkillName(name);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    loaded_skill_names.push(normalized);
  }
  if (loaded_skill_names.length === 0) return undefined;
  return {
    loaded_skill_names,
    loaded_skills: loaded_skill_names.map((name) => ({ name })),
  };
}

function explicitSkillNamesFromText(text: string): string[] {
  const names: string[] = [];

  for (const match of text.matchAll(/\$([A-Za-z0-9_.:-]+)/g)) {
    names.push(match[1] ?? "");
  }

  for (const match of text.matchAll(/(?:^|\s)\/skills\s+([A-Za-z0-9_.:-]+)/g)) {
    names.push(match[1] ?? "");
  }

  for (const match of text.matchAll(/skill:\/\/([A-Za-z0-9_.:-]+)/g)) {
    names.push(match[1] ?? "");
  }

  for (const match of text.matchAll(/(?:^|[\s"'])([^\s"']*SKILL\.md)(?:$|[\s"'])/gi)) {
    const skillPath = match[1];
    if (skillPath !== undefined) names.push(basename(dirname(skillPath)));
  }

  for (const match of text.matchAll(/UserInput::Skill\(([^)]*)\)/g)) {
    const raw = match[1] ?? "";
    const name = raw.match(/(?:name|skill|id)\s*[:=]\s*["']?([A-Za-z0-9_.:-]+)/)?.[1];
    if (name !== undefined) names.push(name);
  }

  for (const match of text.matchAll(/<skill\b([^>]*)>([\s\S]*?)<\/skill>/gi)) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const attrName = attrs.match(/\b(?:name|id)=["']([^"']+)["']/)?.[1];
    if (attrName !== undefined) names.push(attrName);
    const frontmatterName = body.match(/(?:^|\n)name:\s*([A-Za-z0-9_.:-]+)/)?.[1];
    if (frontmatterName !== undefined) names.push(frontmatterName);
  }

  return explicitSkillRequestMetadata(names)?.loaded_skill_names ?? [];
}

function addExplicitSkillNames(turn: OpenTurn, names: readonly string[]): string[] {
  const metadata = explicitSkillRequestMetadata([...turn.explicitSkillNames, ...names]);
  turn.explicitSkillNames = metadata?.loaded_skill_names ?? [];
  return turn.explicitSkillNames;
}

function skillLoadTriggerForTurn(
  turn: OpenTurn,
  skillLoad: SkillLoadInfo | undefined,
): "explicit" | undefined {
  if (skillLoad?.skillName === undefined) return undefined;
  return turn.explicitSkillNames.includes(skillLoad.skillName) ? "explicit" : undefined;
}

function detectCodexSkillLoad(
  toolName: string | undefined,
  args: unknown,
): SkillLoadInfo | undefined {
  if (toolName === "skills.read") {
    const obj = parseArgsObject(args);
    const skillName =
      typeof obj?.name === "string"
        ? obj.name
        : typeof obj?.package === "string"
          ? obj.package
          : undefined;
    return {
      skillName,
    };
  }

  for (const candidate of stringCandidates(args)) {
    const skillPath = candidate.match(/(?:^|[\s"'])([^\s"']*SKILL\.md)(?:$|[\s"'])/i)?.[1];
    if (skillPath !== undefined) {
      return {
        skillName: basename(dirname(skillPath)),
        skillPath,
      };
    }

    const scriptPath = candidate.match(
      /(?:^|[\s"'])([^\s"']*[\\/]scripts[\\/][^\s"']+)(?:$|[\s"'])/i,
    )?.[1];
    if (scriptPath !== undefined) {
      return {
        skillName: basename(dirname(dirname(scriptPath))),
        skillPath: scriptPath,
      };
    }
  }

  return undefined;
}

function skillLoadMetadata(info: SkillLoadInfo | undefined): Record<string, unknown> {
  if (info === undefined) return {};
  return {
    ...(info.skillName !== undefined ? { skill_name: info.skillName } : {}),
    ...(info.skillPath !== undefined ? { skill_path: info.skillPath } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function conciseErrorText(value: unknown, fallback: string): string {
  if (typeof value === "string") return value.split("\n")[0] || fallback;
  if (value instanceof Error) return value.message || fallback;
  if (isObject(value)) {
    const candidate = value.error ?? value.message ?? value.stderr ?? value.output ?? value.result;
    if (typeof candidate === "string") return candidate.split("\n")[0] || fallback;
  }
  return fallback;
}

function classifyToolOutput(output: unknown): { error?: string } {
  if (isObject(output)) {
    if (output.is_error === true || output.isError === true) {
      return { error: conciseErrorText(output, "Tool execution failed") };
    }
    if (output.status === "error" || output.status === "failed") {
      return { error: conciseErrorText(output, "Tool execution failed") };
    }
    if (output.error !== undefined) {
      return {
        error: conciseErrorText(output.error, "Tool execution failed"),
      };
    }
    const exitCode = output.exit_code ?? output.exitCode;
    if (typeof exitCode === "number" && exitCode !== 0) {
      return {
        error: conciseErrorText(output, `Exit code ${exitCode}`),
      };
    }
  }

  if (typeof output === "string") {
    const firstLine = output.split("\n")[0] ?? output;
    if (/^Error:/i.test(firstLine)) return { error: firstLine };
    const exitMatch = /^Exit code\s+(-?\d+)/i.exec(firstLine);
    if (exitMatch !== null && Number(exitMatch[1]) !== 0) {
      return { error: firstLine };
    }
  }

  return {};
}

// ConversationItems (chat messages / reasoning) are already plain JSON, so they
// round-trip through a snapshot unchanged. These two helpers just bridge the
// nominal type boundary between the live union and the snapshot's record array
// (via unknown) without copying.
function toItemSnapshots(items: ConversationItem[]): ConversationItemSnapshot[] {
  return items as unknown as ConversationItemSnapshot[];
}
function fromItemSnapshots(items: ConversationItemSnapshot[]): ConversationItem[] {
  return items as unknown as ConversationItem[];
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
  // The time (Unix seconds) the root span was ended, if it has been. Persisted so
  // that on resume — where rehydrating the root necessarily re-emits its row — we
  // can re-assert the end time and keep the root closed, rather than leaving it
  // looking open (a rehydrated handle is created with no end).
  private rootEndTime: number | undefined;
  // Root enrichment from the SessionStart hook (source/permission_mode), which
  // the transcript lacks. Applied when the root span is created, or patched onto
  // the root if it already exists.
  private rootEnrichment: RootEnrichment = {};
  // Reads new transcript content on each hook (the "catch-up").
  private readonly transcriptReader: TranscriptReader;
  // One parsing scope per transcript file (the main session plus one per
  // subagent), keyed by transcript path. Each owns its own offset and open
  // spans, so interleaved hooks for different files never cross-contaminate.
  private readonly scopes = new Map<string, TranscriptScope>();
  // The main session's scope (its turns hang under the root span). Created on
  // the first hook carrying the main transcript path.
  private mainScope: TranscriptScope | null = null;
  // call_id -> the turn span that contains a spawn_agent tool call, recorded when
  // that tool span opens in the main transcript. The spawn_agent PostToolUse hook
  // carries the resulting agent_id and the call_id (tool_use_id), letting us map
  // agent_id to that turn span (below). We keep the TURN (not the tool span) so a
  // subagent's root can be parented as a SIBLING of the spawn_agent tool — both
  // under the same turn — rather than nested inside the tool.
  private readonly spawnTurnSpansByCallId = new Map<string, Span>();
  // agent_id -> the turn span under which that subagent should be parented (the
  // turn that ran the spawn_agent tool). Resolved from the spawn_agent PostToolUse
  // (agent_id + call_id) via spawnTurnSpansByCallId.
  private readonly spawnTurnSpansByAgentId = new Map<string, Span>();
  // turn_id -> compaction trigger ("manual"/"auto"), recorded from the
  // PreCompact/PostCompact hooks (the transcript's compacted record lacks the
  // trigger). A side map so the hook and the transcript's compacted record can
  // arrive in any order: whichever comes first stores its half here / below, and
  // the second one reconciles. (On a resumed session the transcript's compacted
  // record is read during SessionStart's catch-up, before the hook arrives.)
  private readonly compactionTriggerByTurn = new Map<string, string>();
  // turn_id -> the compaction span built from the transcript, kept so a later
  // PreCompact/PostCompact hook can back-fill the trigger onto it.
  private readonly compactionSpansByTurn = new Map<string, Span>();
  // span_id -> the name/type the span was created (or renamed) with. The SDK
  // doesn't expose these as getters, but a rehydrated span must re-assert them
  // (else the SDK infers a wrong name from the call stack on resume), so we
  // remember them here and feed them into each SpanRef at serialize time.
  private readonly spanAttrs = new Map<
    string,
    { name: string; type: SpanRef["type"]; startTime: number | undefined }
  >();
  // Optional per-session state store. When present, the processor persists a
  // snapshot of its resumable state on flush and, on its first event, rehydrates
  // any snapshot left by a previous server run for this session (so a session
  // that outlived the server — idle shutdown or explicit close+resume — keeps
  // building the same trace instead of starting over). Null disables resume.
  private readonly snapshotStore: SnapshotStore | null;
  // Whether we've already attempted a one-time restore from the store. Restore
  // runs lazily on the first non-config event, once the span factory exists.
  private restoreAttempted = false;

  constructor(
    queueId: string | null,
    logger: Logger,
    spanFactoryProvider: SpanFactoryProvider = defaultSpanFactoryProvider,
    transcriptReader: TranscriptReader = defaultTranscriptReader,
    snapshotStore: SnapshotStore | null = null,
  ) {
    this.queueId = queueId;
    this.logger = logger;
    this.spanFactoryProvider = spanFactoryProvider;
    this.transcriptReader = transcriptReader;
    this.snapshotStore = snapshotStore;
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
  // it carries (root enrichment, subagent lifecycle), (b) catches up the
  // relevant transcript into spans, and on a main-session Stop (c) ends the root
  // span. Wrapped so transcript work can never break the turn.
  async process(event: EnqueueEvent): Promise<void> {
    if (event.eventName === CODEX_CONFIG_EVENT) {
      this.configure(event);
      return;
    }

    // First real event for this session: if a previous server run left a
    // snapshot (idle shutdown mid-session, or an explicit close+resume), rebuild
    // our state from it before processing. Runs once, regardless of which hook
    // arrives first — the very next hook after a restart may not be SessionStart,
    // and may not be preceded by a config event. Restore brings back the
    // session's reporting config, so it MUST run before the master-switch check
    // below (otherwise a resumed session with no leading config event would look
    // untraced and we'd drop its events).
    this.ensureRestored();

    // Master switch: when tracing is disabled, drop everything (no SDK calls).
    if (!this.tracingEnabled) {
      this.logger.debug("codex processor: tracing disabled; dropping event", {
        queueId: this.queueId,
        eventName: event.eventName,
      });
      return;
    }

    const data = (event.eventData ?? {}) as Record<string, unknown>;
    const agentId = typeof data.agent_id === "string" ? data.agent_id : undefined;

    if (event.eventName === SESSION_START) {
      this.recordRootEnrichment(event);
    }

    // Compaction trigger is hook-only (not in the transcript). Record it keyed by
    // turn_id, and if the compaction span was already built from the transcript
    // (e.g. on a resumed session its compacted record is read during
    // SessionStart's catch-up, before this hook arrives), back-fill the trigger
    // onto it now. Order-independent: handleCompacted reads the map; this patches
    // the span — whichever happens second reconciles.
    if (event.eventName === PRE_COMPACT || event.eventName === POST_COMPACT) {
      const turnId = typeof data.turn_id === "string" ? data.turn_id : undefined;
      const trigger = typeof data.trigger === "string" ? data.trigger : undefined;
      if (turnId !== undefined && trigger !== undefined) {
        this.compactionTriggerByTurn.set(turnId, trigger);
        this.backfillCompactionTrigger(turnId, trigger);
      }
    }

    // A subagent is starting: open its root span (under the spawn_agent tool that
    // created it) and register a scope for its transcript so its hooks build a
    // full turn/llm/tool hierarchy inside that span.
    if (event.eventName === SUBAGENT_START) {
      this.handleSubagentStart(event);
    }

    // Resolve the scope this hook belongs to (main vs. a specific subagent) by
    // its transcript path, so each file keeps its own offset and open spans.
    const scope = this.scopeForEvent(event);

    // A turn-terminal signal: the turn is finishing, so mark it (flush, and the
    // catch-up below, wait for this turn's task_complete, which Codex may write
    // after the hook). Stop ends a normal turn; SubagentStop ends a subagent
    // turn; PostCompact ends a compaction turn (which gets no Stop of its own).
    if (isTurnTerminal(event.eventName) && scope !== null) {
      const turnId = typeof data.turn_id === "string" ? data.turn_id : undefined;
      if (turnId !== undefined) scope.turnsAwaitingCompletion.add(turnId);
    }

    if (scope !== null) {
      try {
        await this.catchUpScope(scope, event);
      } catch (err) {
        this.logger.error("codex processor: transcript catch-up failed", {
          queueId: this.queueId,
          eventName: event.eventName,
          error: String(err),
        });
      }
    }

    // After catching up the main transcript (which creates the spawn_agent tool
    // span), map the resulting subagent's agent_id to that span so a following
    // SubagentStart can nest the subagent under it. The PostToolUse's tool_use_id
    // is the spawn_agent function_call's call_id; its tool_response carries the
    // agent_id.
    if (event.eventName === POST_TOOL_USE && agentId === undefined) {
      this.recordSpawnedAgent(event);
    }

    // A subagent has finished: close its turns and root span.
    if (event.eventName === SUBAGENT_STOP && agentId !== undefined) {
      this.handleSubagentStop(event, agentId);
    }

    // End the (main) root span on the first main-session Stop. A SubagentStop
    // must NOT end the root — the parent session is still running.
    if (event.eventName === STOP && agentId === undefined) {
      this.endRootSpan(this.mainScope?.lastTurnEndTime);
    }
  }

  // Read transcript lines appended to this scope's file since its last read and
  // turn each into spans. Never throws.
  //
  // On a turn-terminal hook (Stop/SubagentStop/PostCompact), first consume
  // whatever's already on disk. If that closes the turn, we're done. Otherwise
  // Codex hasn't written this turn's task_complete yet (it can lag the hook by
  // seconds), so wait (bounded) for it — but only then, so a hook whose turn is
  // already complete returns immediately. PostCompact matters specifically
  // because a compaction turn gets no Stop, so without this its span would stay
  // open until idle eviction (and may never be flushed).
  private async catchUpScope(scope: TranscriptScope, event: EnqueueEvent): Promise<void> {
    const data = (event.eventData ?? {}) as Record<string, unknown>;

    // Initial read of everything available now.
    const initial = this.transcriptReader.readFrom(scope.path, scope.offset);
    scope.offset = initial.offset;
    this.consumeLines(scope, initial.lines);

    if (!isTurnTerminal(event.eventName)) return;

    const turnId = typeof data.turn_id === "string" ? data.turn_id : undefined;
    // If the turn already closed during the initial read, no wait is needed.
    if (turnId === undefined || !scope.openTurns.has(turnId)) return;

    // Wait (bounded) for this turn's task_complete to be written.
    const result = await this.transcriptReader.waitFor(
      scope.path,
      scope.offset,
      (line) => this.isTaskCompleteFor(line, turnId),
      { timeoutMs: SENTINEL_TIMEOUT_MS, intervalMs: SENTINEL_INTERVAL_MS },
    );
    scope.offset = result.offset;
    this.consumeLines(scope, result.lines);
    if (!result.sentinelFound) {
      this.logger.warn("codex processor: task_complete sentinel not found; partial turn", {
        queueId: this.queueId,
        eventName: event.eventName,
        turnId,
      });
    }
  }

  // ==========================================================================
  // Transcript scopes
  // ==========================================================================

  // Resolve (creating if needed) the scope a hook belongs to, by its transcript
  // path. A subagent hook (carrying agent_id) uses the subagent's transcript;
  // its scope is created by SubagentStart and looked up here. Everything else is
  // the main session. Returns null if the hook carries no usable transcript path
  // or a subagent scope hasn't been registered yet.
  private scopeForEvent(event: EnqueueEvent): TranscriptScope | null {
    const data = (event.eventData ?? {}) as Record<string, unknown>;
    const agentId = typeof data.agent_id === "string" ? data.agent_id : undefined;
    // SubagentStop reports the subagent file under agent_transcript_path (its
    // transcript_path points at the PARENT session), so prefer that.
    const path =
      agentId !== undefined && typeof data.agent_transcript_path === "string"
        ? data.agent_transcript_path
        : typeof data.transcript_path === "string"
          ? data.transcript_path
          : undefined;
    if (path === undefined) return null;

    if (agentId === undefined) return this.ensureMainScope(path);

    // Subagent hook: its scope must already exist (registered by SubagentStart).
    const existing = this.scopes.get(path);
    if (existing !== undefined) return existing;
    this.logger.debug("codex processor: subagent hook before its scope exists; skipping", {
      queueId: this.queueId,
      agentId,
    });
    return null;
  }

  // The main session's scope, created on first use. Its turns hang under the
  // processor's root span.
  private ensureMainScope(path: string): TranscriptScope {
    if (this.mainScope !== null) return this.mainScope;
    const scope = this.newScope(path, "main", () => this.rootSpan);
    this.mainScope = scope;
    this.scopes.set(path, scope);
    return scope;
  }

  private newScope(
    path: string,
    kind: "main" | "subagent",
    parentSpan: () => Span | null,
  ): TranscriptScope {
    return {
      path,
      kind,
      parentSpan,
      offset: 0,
      openTurns: new Map(),
      turnsAwaitingCompletion: new Set(),
      conversationHistory: [],
      openLlm: null,
      openTools: new Map(),
      model: undefined,
      lastTurnEndTime: undefined,
      subagentRootSpan: null,
      subagentEnded: false,
    };
  }

  // ==========================================================================
  // Subagent lifecycle
  // ==========================================================================

  // Record the agent_id produced by a spawn_agent tool, mapping it to that
  // tool's span (located by call_id), so a later SubagentStart can parent the
  // subagent's root span under the spawning tool. No-op for non-spawn tools or
  // when the tool span isn't known.
  private recordSpawnedAgent(event: EnqueueEvent): void {
    const data = (event.eventData ?? {}) as Record<string, unknown>;
    const toolName = typeof data.tool_name === "string" ? data.tool_name : undefined;
    if (toolName !== SPAWN_AGENT_TOOL) return;
    const callId = typeof data.tool_use_id === "string" ? data.tool_use_id : undefined;
    if (callId === undefined) return;
    const response = data.tool_response;
    let agentId: string | undefined;
    if (typeof response === "string") {
      try {
        const parsed = JSON.parse(response) as Record<string, unknown>;
        if (typeof parsed.agent_id === "string") agentId = parsed.agent_id;
      } catch {
        // tool_response wasn't JSON; nothing to map.
      }
    } else if (response !== null && typeof response === "object") {
      const ar = (response as Record<string, unknown>).agent_id;
      if (typeof ar === "string") agentId = ar;
    }
    if (agentId === undefined) return;
    const turnSpan = this.spawnTurnSpansByCallId.get(callId);
    if (turnSpan === undefined) {
      this.logger.debug("codex processor: spawn_agent PostToolUse with no known turn span", {
        queueId: this.queueId,
        callId,
        agentId,
      });
      return;
    }
    this.spawnTurnSpansByAgentId.set(agentId, turnSpan);
  }

  // A subagent is starting. Register a scope reading the subagent's own
  // transcript so its turns/llm/tools build a full hierarchy. The subagent root
  // span is created lazily from the subagent's session_meta (so it gets a real
  // start time); we stash the parent here — the turn span that ran the
  // spawn_agent tool (matched by agent_id from the spawn_agent PostToolUse), so
  // the subagent root is a SIBLING of that spawn_agent tool span. Falls back to
  // the main root span if that mapping isn't known.
  private handleSubagentStart(event: EnqueueEvent): void {
    const data = (event.eventData ?? {}) as Record<string, unknown>;
    const agentId = typeof data.agent_id === "string" ? data.agent_id : undefined;
    const path = typeof data.transcript_path === "string" ? data.transcript_path : undefined;
    if (agentId === undefined || path === undefined) {
      this.logger.warn("codex processor: SubagentStart missing agent_id/transcript_path", {
        queueId: this.queueId,
      });
      return;
    }
    if (this.scopes.has(path)) return; // already registered

    const parent = this.spawnTurnSpansByAgentId.get(agentId) ?? this.rootSpan;
    if (parent === null) {
      this.logger.warn("codex processor: SubagentStart with no parent span; skipping", {
        queueId: this.queueId,
        agentId,
      });
      return;
    }
    const agentType = typeof data.agent_type === "string" ? data.agent_type : undefined;
    const scope = this.newScope(path, "subagent", () => scope.subagentRootSpan);
    scope.pendingSubagent = { agentId, agentType, parent };
    this.scopes.set(path, scope);
    this.logger.info("codex processor: registered subagent scope", {
      queueId: this.queueId,
      agentId,
    });
  }

  // Create a subagent's root span from its session_meta record (sibling of the
  // spawn_agent tool span — both under the spawning turn — with the record's
  // timestamp as start time). Called once per subagent scope, when its
  // session_meta is first consumed.
  private startSubagentRootSpan(scope: TranscriptScope, record: TranscriptRecord): void {
    const pending = scope.pendingSubagent;
    if (pending === undefined || scope.subagentRootSpan !== null) return;
    const startTime = isoToUnixSeconds(record.timestamp);
    try {
      const subagentName = `subagent: ${pending.agentId}`;
      scope.subagentRootSpan = this.trackSpan(
        pending.parent.startSpan({
          name: subagentName,
          type: "task",
          ...(startTime !== undefined ? { startTime } : {}),
          event: {
            metadata: {
              agent_id: pending.agentId,
              agent_type: pending.agentType,
              // The subagent's own rollout transcript on disk.
              transcript_path: scope.path,
            },
          },
        }),
        subagentName,
        "task",
        startTime,
      );
      this.logger.info("codex processor: opened subagent root span", {
        queueId: this.queueId,
        agentId: pending.agentId,
        spanId: scope.subagentRootSpan.id,
      });
    } catch (err) {
      this.logger.error("codex processor: failed to open subagent root span", {
        queueId: this.queueId,
        agentId: pending.agentId,
        error: String(err),
      });
    }
  }

  // A subagent has finished (its task_complete has been consumed by the catch-up
  // in process()). Close any spans still open in its scope, then end its root
  // span at the subagent's last turn end time.
  private handleSubagentStop(event: EnqueueEvent, agentId: string): void {
    const data = (event.eventData ?? {}) as Record<string, unknown>;
    const path =
      typeof data.agent_transcript_path === "string" ? data.agent_transcript_path : undefined;
    const scope = path !== undefined ? this.scopes.get(path) : undefined;
    if (scope === undefined || scope.subagentRootSpan === null) {
      this.logger.debug("codex processor: SubagentStop with no scope/root span", {
        queueId: this.queueId,
        agentId,
      });
      return;
    }
    if (scope.subagentEnded) return;
    scope.subagentEnded = true;
    const endTime = scope.lastTurnEndTime;
    const endArgs = endTime !== undefined ? { endTime } : undefined;
    this.endOpenLlmSpan(scope, endTime);
    this.closeAllOpenTools(scope, endArgs);
    for (const [, turn] of scope.openTurns) {
      try {
        turn.span.end(endArgs);
      } catch (err) {
        this.logger.error("codex processor: failed to end dangling subagent turn span", {
          queueId: this.queueId,
          agentId,
          error: String(err),
        });
      }
    }
    scope.openTurns.clear();
    try {
      scope.subagentRootSpan.end(endArgs);
      this.logger.info("codex processor: ended subagent root span", {
        queueId: this.queueId,
        agentId,
      });
    } catch (err) {
      this.logger.error("codex processor: failed to end subagent root span", {
        queueId: this.queueId,
        agentId,
        error: String(err),
      });
    }
  }

  // Parse and process a batch of transcript lines into spans for the given
  // scope, advancing nothing (the caller owns the offset). Used by catch-up and
  // by the final flush read.
  private consumeLines(scope: TranscriptScope, lines: string[]): void {
    // A finalized subagent scope is inert: never re-open/mutate its spans (a
    // re-read after SubagentStop would otherwise re-open already-closed spans).
    if (scope.subagentEnded) return;
    for (const line of lines) {
      const record = parseTranscriptLine(line);
      if (record === null) continue;
      this.processTranscriptEvent(scope, record);
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

  // Turn one parsed transcript record into span operations for its scope.
  // Unknown record types are ignored. Never throws; per-record failures logged.
  private processTranscriptEvent(scope: TranscriptScope, record: TranscriptRecord): void {
    try {
      if (record.type === RECORD_SESSION_META) {
        // The main session's session_meta opens the processor root span; a
        // subagent's opens its (lazily created) subagent root span.
        if (scope.kind === "main") this.startRootSpan(record);
        else this.startSubagentRootSpan(scope, record);
        return;
      }
      if (record.type === RECORD_TURN_CONTEXT) {
        this.noteModel(scope, record);
        return;
      }
      if (record.type === RECORD_COMPACTED) {
        this.handleCompacted(scope, record);
        return;
      }
      if (record.type === RECORD_EVENT_MSG) {
        const ptype = record.payload?.type;
        if (ptype === EVT_TASK_STARTED) this.startTurnSpan(scope, record);
        else if (ptype === EVT_USER_MESSAGE) this.setTurnInput(scope, record);
        else if (ptype === EVT_TASK_COMPLETE) this.endTurnSpan(scope, record);
        else if (ptype === EVT_TOKEN_COUNT) this.closeLlmSpan(scope, record);
        return;
      }
      if (record.type === RECORD_RESPONSE_ITEM) {
        const ptype = record.payload?.type ?? "";
        if (ptype === ITEM_MESSAGE) this.handleMessageItem(scope, record);
        else if (ptype === ITEM_REASONING) this.handleReasoningItem(scope, record);
        else if (TOOL_CALL_TYPES.has(ptype)) this.startToolSpan(scope, record);
        else if (TOOL_OUTPUT_TYPES.has(ptype)) this.endToolSpan(scope, record);
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
      parentSpanId: typeof data.parentSpanId === "string" ? data.parentSpanId : undefined,
      rootSpanId: typeof data.rootSpanId === "string" ? data.rootSpanId : undefined,
    };
    this.logger.info("codex processor: configured reporting", {
      queueId: this.queueId,
      project: this.reportingConfig.project,
      apiUrl: this.reportingConfig.apiUrl,
      hasApiKey: Boolean(this.reportingConfig.apiKey),
      traceToBraintrust: this.reportingConfig.traceToBraintrust,
      hasParentSpan: Boolean(this.reportingConfig.parentSpanId),
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
          metadata: {
            source: this.rootEnrichment.source,
            permission_mode: this.rootEnrichment.permissionMode,
          },
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
    const gitMetadata = gitMetadataForCwd(cwd);

    const projectDir = projectDirName(cwd);
    const spanName = projectDir ? `codex: ${projectDir}` : "codex session";

    try {
      this.rootSpan = this.trackSpan(
        this.spanFactory.startSpan({
          name: spanName,
          type: "task",
          ...(this.reportingConfig?.parentSpanId && this.reportingConfig?.rootSpanId
            ? {
                parentSpanIds: {
                  parentSpanIds: [this.reportingConfig.parentSpanId],
                  rootSpanId: this.reportingConfig.rootSpanId,
                },
              }
            : {}),
          ...(startTime !== undefined ? { startTime } : {}),
          event: {
            input: { model: this.mainScope?.model, cwd, source: this.rootEnrichment.source },
            metadata: {
              // User-provided extras first, so the standard keys below win.
              ...this.reportingConfig?.additionalMetadata,
              session_id: sessionId,
              model: this.mainScope?.model,
              cwd,
              ...gitMetadata,
              source: this.rootEnrichment.source,
              permission_mode: this.rootEnrichment.permissionMode,
              cli_version:
                typeof payload.cli_version === "string" ? payload.cli_version : undefined,
              project: this.reportingConfig?.project,
              // The session's rollout transcript on disk (the source for this trace).
              transcript_path: this.mainScope?.path,
            },
          },
        }),
        spanName,
        "task",
        startTime,
      );
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

  // Learn the scope's model from turn_context (session_meta has none). Backfill
  // it onto the scope's parent span input/metadata the first time we see it.
  private noteModel(scope: TranscriptScope, record: TranscriptRecord): void {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const model = typeof payload.model === "string" ? payload.model : undefined;
    if (model === undefined || scope.model !== undefined) return;
    scope.model = model;
    const parent = scope.parentSpan();
    if (parent !== null) {
      try {
        parent.log({ input: { model }, metadata: { model } });
      } catch (err) {
        this.logger.error("codex processor: failed to backfill model", {
          queueId: this.queueId,
          error: String(err),
        });
      }
    }
  }

  // Open a turn span on task_started, child of the scope's parent, by turn_id.
  private startTurnSpan(scope: TranscriptScope, record: TranscriptRecord): void {
    const parent = scope.parentSpan();
    if (parent === null) {
      this.logger.warn("codex processor: task_started without a parent span; ignoring", {
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
    if (scope.openTurns.has(turnId)) {
      this.logger.warn("codex processor: duplicate turn_id; keeping existing turn span", {
        queueId: this.queueId,
        turnId,
      });
      return;
    }
    const startTime = isoToUnixSeconds(record.timestamp);
    const turnName = `turn: ${turnId}`;
    try {
      const turnSpan = this.trackSpan(
        parent.startSpan({
          name: turnName,
          type: "task",
          ...(startTime !== undefined ? { startTime } : {}),
          event: { metadata: { turn_id: turnId, model: scope.model } },
        }),
        turnName,
        "task",
        startTime,
      );
      scope.openTurns.set(turnId, {
        span: turnSpan,
        startTime,
        lastChildEndTime: undefined,
        explicitSkillNames: [],
      });
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

  // Handle a `compacted` record: the current turn is a context compaction (Codex
  // runs it as its own turn). Relabel that turn span as a "compaction" span with
  // metadata (trigger from the PreCompact/PostCompact hook, the count of messages
  // the compaction collapsed to, and the window_id) and a tag, then open an llm
  // span representing the compaction model call. The following token_count closes
  // that llm span with its token usage, so the trace shows what the compaction
  // did: the conversation before it (input) and the kept context after (output).
  private handleCompacted(scope: TranscriptScope, record: TranscriptRecord): void {
    const turnId = this.latestOpenTurnId(scope);
    const turn = this.latestOpenTurn(scope);
    if (turnId === undefined || turn === undefined) {
      this.logger.debug("codex processor: compacted record with no open turn span", {
        queueId: this.queueId,
      });
      return;
    }
    const turnSpan = turn.span;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const replacement = Array.isArray(payload.replacement_history)
      ? (payload.replacement_history as unknown[])
      : undefined;
    const trigger = this.compactionTriggerByTurn.get(turnId);

    // Relabel the turn span as a compaction span and annotate it. Keep the span
    // so a PreCompact/PostCompact hook arriving later can back-fill the trigger.
    this.compactionSpansByTurn.set(turnId, turnSpan);
    try {
      turnSpan.setAttributes({ name: "compaction", type: "task" });
      // Remember the rename so a resumed snapshot re-asserts "compaction", not
      // the original "turn: ..." name. Preserve the span's original start time.
      this.spanAttrs.set(turnSpan.spanId, {
        name: "compaction",
        type: "task",
        startTime: this.spanAttrs.get(turnSpan.spanId)?.startTime,
      });
      turnSpan.log({
        metadata: {
          compaction: {
            trigger,
            replaced_message_count: replacement?.length,
            window_id: payload.window_id,
          },
        },
        tags: [COMPACTION_TAG],
      });
    } catch (err) {
      this.logger.error("codex processor: failed to annotate compaction span", {
        queueId: this.queueId,
        turnId,
        error: String(err),
      });
    }

    // Open an llm span for the compaction model call. To make it self-evident
    // (and avoid the "model just echoed the user" look), shape input/output as
    // before/after of the context window:
    //   input  = the conversation history before compaction (+ its count)
    //   output = the kept context after compaction (readable messages) plus a
    //            clear marker for the summary, which Codex stores encrypted and
    //            does not expose to us.
    // Closed by the turn's token_count (metrics) like any other model call.
    // Start the span at the turn's start (compaction is the sole child), not the
    // record timestamp (which is when the compaction result lands), so its
    // duration reflects the compaction call rather than looking instant.
    const startTime = this.llmStartTimeFor(turn) ?? isoToUnixSeconds(record.timestamp);
    const before = scope.conversationHistory.map((item) => ({ ...item }));
    const output = compactionOutput(replacement);
    const compactionLlmName = scope.model ?? "compaction";
    try {
      const span = this.trackSpan(
        turnSpan.startSpan({
          name: compactionLlmName,
          type: "llm",
          ...(startTime !== undefined ? { startTime } : {}),
          event: {
            input: { messages_before_compaction: before.length, history: before },
            output,
            metadata: { model: scope.model, turn_id: turnId, compaction: true },
          },
        }),
        compactionLlmName,
        "llm",
        startTime,
      );
      // Reuse the open-llm slot so the turn's token_count closes it with usage.
      // outputPreset: the replacement history is already logged as the output, so
      // the closing token_count must not overwrite it. lastOutputTime is the
      // compacted record's time (when the compaction output landed); the closing
      // token_count provides metrics only.
      scope.openLlm = {
        span,
        turnId,
        output: [],
        outputPreset: true,
        lastOutputTime: isoToUnixSeconds(record.timestamp),
      };
    } catch (err) {
      this.logger.error("codex processor: failed to open compaction llm span", {
        queueId: this.queueId,
        turnId,
        error: String(err),
      });
    }
  }

  // Patch the trigger onto a compaction span when its PreCompact/PostCompact hook
  // arrives after the span was already built from the transcript. No-op if the
  // span isn't known yet (handleCompacted will read the trigger from the map).
  private backfillCompactionTrigger(turnId: string, trigger: string): void {
    const span = this.compactionSpansByTurn.get(turnId);
    if (span === undefined) return;
    try {
      span.log({ metadata: { compaction: { trigger } } });
    } catch (err) {
      this.logger.error("codex processor: failed to back-fill compaction trigger", {
        queueId: this.queueId,
        turnId,
        error: String(err),
      });
    }
  }

  // Set the open turn's input from a user_message event (the prompt). The
  // user_message carries no turn_id, so it applies to the most recently opened
  // still-open turn in this scope.
  private setTurnInput(scope: TranscriptScope, record: TranscriptRecord): void {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const prompt = typeof payload.message === "string" ? payload.message : undefined;
    if (prompt === undefined) return;
    // Note: we do NOT add the prompt to conversationHistory here — the same
    // prompt also arrives as a response_item user message (handleMessageItem),
    // which is the canonical source for history. This event only sets the turn's
    // input for display.
    const turn = this.latestOpenTurn(scope);
    if (turn === undefined) {
      this.logger.debug("codex processor: user_message with no open turn span", {
        queueId: this.queueId,
      });
      return;
    }
    try {
      const names = explicitSkillNamesFromText(prompt);
      const loadedSkillMetadata = explicitSkillRequestMetadata(addExplicitSkillNames(turn, names));
      turn.span.log({ input: prompt, metadata: loadedSkillMetadata });
    } catch (err) {
      this.logger.error("codex processor: failed to set turn input", {
        queueId: this.queueId,
        error: String(err),
      });
    }
  }

  private annotateLatestTurnWithExplicitSkills(scope: TranscriptScope, text: string): void {
    const turn = this.latestOpenTurn(scope);
    if (turn === undefined) return;
    const names = explicitSkillNamesFromText(text);
    const loadedSkillMetadata = explicitSkillRequestMetadata(addExplicitSkillNames(turn, names));
    if (loadedSkillMetadata === undefined) return;
    try {
      turn.span.log({ metadata: loadedSkillMetadata });
    } catch (err) {
      this.logger.error("codex processor: failed to annotate explicit skill request", {
        queueId: this.queueId,
        error: String(err),
      });
    }
  }

  // Close the turn span on task_complete, recording the final assistant message
  // as output. Also closes any tool spans still open under that turn.
  private endTurnSpan(scope: TranscriptScope, record: TranscriptRecord): void {
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
    const turn = scope.openTurns.get(turnId);
    if (turn === undefined) {
      this.logger.debug("codex processor: task_complete with no open turn span", {
        queueId: this.queueId,
        turnId,
      });
      return;
    }
    const turnSpan = turn.span;
    const endTime = isoToUnixSeconds(record.timestamp);
    // Backstop: close any spans still open without their own closing record
    // (a trailing model call with no token_count, or a tool with no output) at
    // the turn's end time.
    this.endOpenLlmSpan(scope, endTime);
    this.endOpenToolSpansForTurn(scope, turnId, endTime);
    try {
      turnSpan.log({ output });
      turnSpan.end(endTime !== undefined ? { endTime } : undefined);
      if (endTime !== undefined) scope.lastTurnEndTime = endTime;
      this.logger.info("codex processor: ended turn span", { queueId: this.queueId, turnId });
    } catch (err) {
      this.logger.error("codex processor: failed to end turn span", {
        queueId: this.queueId,
        turnId,
        error: String(err),
      });
    } finally {
      scope.openTurns.delete(turnId);
      scope.turnsAwaitingCompletion.delete(turnId);
    }
  }

  // ==========================================================================
  // LLM spans (transcript-driven)
  //
  // One LLM call = a run of reasoning/message (+ tool) items terminated by a
  // token_count. The span opens lazily on the first model-output item (assistant
  // message or reasoning) and closes at the next token_count, which carries the
  // call's token usage. Tool calls the model emits are sibling tool spans under
  // the turn (handled elsewhere); the assistant text/reasoning is the LLM span's
  // output, and its input is the conversation reconstructed up to the open.
  // ==========================================================================

  // Ensure an LLM span is open for the scope's current model call, opening one
  // (child of the active turn) on first use with input = the conversation so far.
  private ensureLlmSpan(scope: TranscriptScope, record: TranscriptRecord): void {
    if (scope.openLlm !== null) return;
    const turn = this.latestOpenTurn(scope);
    if (turn === undefined) {
      this.logger.debug("codex processor: model output with no open turn; skipping llm span", {
        queueId: this.queueId,
      });
      return;
    }
    const turnId = this.latestOpenTurnId(scope);
    // Start the span where the model's work for this call actually began — the
    // end of the turn's most recently-ended child, or the turn's start when this
    // is the first child — NOT the record timestamp (which is when the model's
    // output landed, just before its token_count, yielding a near-instant span).
    const startTime = this.llmStartTimeFor(turn) ?? isoToUnixSeconds(record.timestamp);
    // Snapshot the conversation as this call's input (the transcript doesn't log
    // the real request, so this is a best-effort reconstruction).
    const input = scope.conversationHistory.map((item) => ({ ...item }));
    const llmName = scope.model ?? "llm";
    try {
      const span = this.trackSpan(
        turn.span.startSpan({
          name: llmName,
          type: "llm",
          ...(startTime !== undefined ? { startTime } : {}),
          event: { input, metadata: { model: scope.model, turn_id: turnId } },
        }),
        llmName,
        "llm",
        startTime,
      );
      scope.openLlm = { span, turnId, output: [], lastOutputTime: startTime };
      this.logger.info("codex processor: opened llm span", {
        queueId: this.queueId,
        turnId,
        spanId: span.id,
      });
    } catch (err) {
      this.logger.error("codex processor: failed to open llm span", {
        queueId: this.queueId,
        error: String(err),
      });
    }
  }

  // Record that the open LLM call produced an output item at `record`'s time,
  // advancing its lastOutputTime. The LLM span ends at this time (when the model
  // last generated), not at the closing token_count (which Codex writes after
  // the tool result). No-op if no LLM span is open.
  private noteLlmOutputTime(scope: TranscriptScope, record: TranscriptRecord): void {
    if (scope.openLlm === null) return;
    const t = isoToUnixSeconds(record.timestamp);
    if (t === undefined) return;
    if (scope.openLlm.lastOutputTime === undefined || t > scope.openLlm.lastOutputTime) {
      scope.openLlm.lastOutputTime = t;
    }
  }

  // Handle a response_item message: an assistant message is this call's output
  // (opens/feeds the LLM span); user/developer messages are input context. All
  // are appended to conversation history as chat messages for reconstructing
  // later calls' inputs.
  private handleMessageItem(scope: TranscriptScope, record: TranscriptRecord): void {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const rawRole = typeof payload.role === "string" ? payload.role : "user";
    const role: ChatMessage["role"] =
      rawRole === "assistant" || rawRole === "developer" || rawRole === "tool" ? rawRole : "user";
    const text = messageText(payload.content);
    if (text === undefined) return;

    const msg: ChatMessage = { role, content: text };
    if (role === "assistant") {
      this.ensureLlmSpan(scope, record);
      scope.openLlm?.output.push(msg);
      this.noteLlmOutputTime(scope, record);
    } else if (role === "user") {
      this.annotateLatestTurnWithExplicitSkills(scope, text);
    }
    scope.conversationHistory.push(msg);
  }

  // Handle a reasoning item: it belongs to the current model call. Open the LLM
  // span and, when the model exposed a readable reasoning summary, surface it as
  // a `reasoning` item in the call's output and in the conversation history (so
  // subsequent calls' input shows the prior thinking too). The full reasoning is
  // encrypted, so items with no readable summary only open the span.
  private handleReasoningItem(scope: TranscriptScope, record: TranscriptRecord): void {
    this.ensureLlmSpan(scope, record);
    // The reasoning item is a model output at this time, even when its summary is
    // encrypted (empty) and adds nothing readable — so advance the span's end.
    this.noteLlmOutputTime(scope, record);
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const summary = reasoningSummary(payload.summary);
    if (summary === undefined) return;
    const item: ReasoningItem = { type: "reasoning", summary };
    scope.openLlm?.output.push(item);
    scope.conversationHistory.push(item);
  }

  // Close the current LLM call on a token_count (the segment boundary): end the
  // LLM span with token-usage metrics and its accumulated output. (Tool spans
  // are opened/closed by their own records, so nothing to flush here.)
  private closeLlmSpan(scope: TranscriptScope, record: TranscriptRecord): void {
    if (scope.openLlm === null) return;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const info = (payload.info ?? {}) as Record<string, unknown>;
    const usage = (info.last_token_usage ?? {}) as Record<string, unknown>;
    const metrics = tokenMetrics(usage);
    const metadata =
      Object.keys(metrics).length === 0
        ? {
            usage_unavailable_reason:
              Object.keys(usage).length === 0
                ? "codex_token_count_missing_usage"
                : "codex_token_count_unrecognized_usage",
          }
        : undefined;
    const { span, turnId, output, outputPreset, lastOutputTime } = scope.openLlm;
    // End the span when the model last generated (its last output item), NOT at
    // this token_count: Codex writes the token_count after the tool result (at
    // the same instant as the tool output), so using it would stretch the span to
    // swallow the tool's execution — making the llm span overlap the tool it
    // called, which is causally impossible. The token_count only supplies metrics.
    // Fall back to the token_count time if we somehow have no output time.
    const endTime = lastOutputTime ?? isoToUnixSeconds(record.timestamp);
    try {
      span.log(
        outputPreset
          ? { metrics, ...(metadata !== undefined ? { metadata } : {}) }
          : { output: llmOutput(output), metrics, ...(metadata !== undefined ? { metadata } : {}) },
      );
      span.end(endTime !== undefined ? { endTime } : undefined);
      // This LLM call is a child of its turn; advance the turn's boundary so the
      // next child (LLM or tool) starts where this one ended (its last output).
      this.noteChildEnded(scope, turnId, endTime);
      this.logger.info("codex processor: ended llm span", { queueId: this.queueId });
    } catch (err) {
      this.logger.error("codex processor: failed to end llm span", {
        queueId: this.queueId,
        error: String(err),
      });
    } finally {
      scope.openLlm = null;
    }
  }

  // End any open LLM span without a closing token_count (e.g. on turn/root end).
  // Prefer the model's last-output time (when generation actually ended) over the
  // caller's fallback endTime (the turn/root end), so a trailing call isn't
  // stretched to the turn boundary.
  private endOpenLlmSpan(scope: TranscriptScope, endTime: number | undefined): void {
    if (scope.openLlm === null) return;
    const { span, turnId, output, lastOutputTime } = scope.openLlm;
    const effectiveEnd = lastOutputTime ?? endTime;
    try {
      const metadata = { usage_unavailable_reason: "codex_transcript_missing_token_count" };
      span.log(output.length > 0 ? { output: llmOutput(output), metadata } : { metadata });
      span.end(effectiveEnd !== undefined ? { endTime: effectiveEnd } : undefined);
      this.noteChildEnded(scope, turnId, effectiveEnd);
    } catch (err) {
      this.logger.error("codex processor: failed to end dangling llm span", {
        queueId: this.queueId,
        error: String(err),
      });
    } finally {
      scope.openLlm = null;
    }
  }

  // Open a tool span (child of its turn) for a tool-call response_item, keyed by
  // call_id so the matching *_output can close it. Each tool span is opened and
  // closed by its own records (no cross-segment buffering), which keeps it robust
  // against the transcript being read in pieces. Tool spans are ordered by their
  // transcript start time, so they render between the LLM calls around them.
  private startToolSpan(scope: TranscriptScope, record: TranscriptRecord): void {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
    // Most tool calls carry `name`; some (e.g. tool_search_call) don't, so fall
    // back to the record subtype with the "_call" suffix stripped.
    const ptype = typeof payload.type === "string" ? payload.type : undefined;
    const name =
      typeof payload.name === "string"
        ? payload.name
        : ptype !== undefined
          ? ptype.replace(/_call$/, "")
          : undefined;
    const meta = (payload.metadata ?? {}) as Record<string, unknown>;
    const turnId = typeof meta.turn_id === "string" ? meta.turn_id : this.latestOpenTurnId(scope);
    // function_call uses `arguments` (a JSON string); custom_tool_call uses `input`.
    const input = payload.arguments ?? payload.input;

    // Record the tool call as an assistant message carrying a tool_call in the
    // conversation history (input context for later calls). Done regardless of
    // whether we end up creating a span, so reconstructed history stays faithful.
    const argsString = typeof input === "string" ? input : JSON.stringify(input ?? {});
    const toolCallMsg: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId ?? "",
          type: "function",
          function: { name: name ?? "tool", arguments: argsString },
        },
      ],
    };
    scope.conversationHistory.push(toolCallMsg);

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
    const turn = scope.openTurns.get(turnId);
    if (turn === undefined) {
      this.logger.warn("codex processor: tool call with no open turn span; skipping", {
        queueId: this.queueId,
        turnId,
        callId,
      });
      return;
    }
    const turnSpan = turn.span;

    // A tool call IS a model output, so it belongs to the current LLM call. Open
    // the LLM span if one isn't already open (a call whose only output is a tool
    // call — no preceding assistant message or readable reasoning — would
    // otherwise leave the model's work, often many seconds, with no llm span,
    // appearing as an unaccounted gap at the front of the turn). Record the tool
    // call as this LLM call's output too. Done only once we know the tool call is
    // valid (real open turn), so a tool call for an unknown turn opens nothing.
    this.ensureLlmSpan(scope, record);
    scope.openLlm?.output.push(toolCallMsg);
    // The model emitted this tool call now — that's when its generation ended.
    this.noteLlmOutputTime(scope, record);
    if (scope.openTools.has(callId)) {
      this.logger.warn("codex processor: duplicate call_id; keeping existing tool span", {
        queueId: this.queueId,
        callId,
      });
      return;
    }
    // If this call requested escalated permissions (Codex records the request
    // inline in the arguments), surface it on the span as metadata and a tag.
    const permission = permissionInfo(input);
    const skillLoad = detectCodexSkillLoad(name, input);
    const skillLoadTrigger = skillLoadTriggerForTurn(turn, skillLoad);
    const startTime = isoToUnixSeconds(record.timestamp);
    const toolName = name ?? "tool";
    const spanName =
      skillLoad?.skillName !== undefined ? `skill: ${skillLoad.skillName}` : toolName;
    try {
      const toolSpan = this.trackSpan(
        turnSpan.startSpan({
          name: spanName,
          type: "tool",
          ...(startTime !== undefined ? { startTime } : {}),
          event: {
            input,
            metadata: {
              tool_name: name,
              ...(skillLoad !== undefined ? { tool_kind: "skill" } : {}),
              call_id: callId,
              turn_id: turnId,
              permission,
              ...skillLoadMetadata(skillLoad),
              ...(skillLoadTrigger !== undefined ? { skill_load_trigger: skillLoadTrigger } : {}),
            },
            ...(permission !== undefined ? { tags: [PERMISSION_TAG] } : {}),
          },
        }),
        spanName,
        "tool",
        startTime,
      );
      scope.openTools.set(callId, { span: toolSpan, turnId });
      // Remember the TURN span that ran a spawn_agent tool (main scope only) so a
      // subagent's root span can be parented as a sibling of the tool (both under
      // this turn). The agent_id isn't in the transcript; it arrives on the
      // spawn_agent PostToolUse hook, which we map to this turn by call_id.
      if (scope.kind === "main" && name === SPAWN_AGENT_TOOL) {
        this.spawnTurnSpansByCallId.set(callId, turnSpan);
      }
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
  // output, and add the result to conversation history as a `tool` message.
  private endToolSpan(scope: TranscriptScope, record: TranscriptRecord): void {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
    const output = payload.output ?? payload.result;
    scope.conversationHistory.push({
      role: "tool",
      content: typeof output === "string" ? output : JSON.stringify(output ?? null),
      tool_call_id: callId ?? "",
    });
    if (callId === undefined) {
      this.logger.debug("codex processor: tool output without call_id", {
        queueId: this.queueId,
      });
      return;
    }
    const entry = scope.openTools.get(callId);
    if (entry === undefined) {
      this.logger.debug("codex processor: tool output with no open tool span", {
        queueId: this.queueId,
        callId,
      });
      return;
    }
    const endTime = isoToUnixSeconds(record.timestamp);
    const { error } = classifyToolOutput(output);
    try {
      entry.span.log({
        output,
        metadata: { tool_approval: "approved" },
        ...(error !== undefined ? { error } : {}),
      });
      entry.span.end(endTime !== undefined ? { endTime } : undefined);
      // A tool is a child of its turn; advance the turn's boundary so a following
      // LLM call (the model resuming after the tool result) starts here.
      this.noteChildEnded(scope, entry.turnId, endTime);
      this.logger.info("codex processor: ended tool span", { queueId: this.queueId, callId });
    } catch (err) {
      this.logger.error("codex processor: failed to end tool span", {
        queueId: this.queueId,
        callId,
        error: String(err),
      });
    } finally {
      scope.openTools.delete(callId);
    }
  }

  // End any still-open tool spans owned by the given turn (e.g. a call whose
  // output never arrived) when the turn ends, at the turn's end time.
  private endOpenToolSpansForTurn(
    scope: TranscriptScope,
    turnId: string,
    endTime: number | undefined,
  ): void {
    for (const [callId, entry] of scope.openTools) {
      if (entry.turnId !== turnId) continue;
      try {
        entry.span.log({
          metadata: { tool_approval: "approved" },
          error: MISSING_TOOL_OUTPUT_ERROR,
        });
        entry.span.end(endTime !== undefined ? { endTime } : undefined);
      } catch (err) {
        this.logger.error("codex processor: failed to end dangling tool span", {
          queueId: this.queueId,
          turnId,
          callId,
          error: String(err),
        });
      } finally {
        scope.openTools.delete(callId);
      }
    }
  }

  // Close every still-open tool span in a scope (used when ending a subagent or
  // the root). Clears the scope's openTools.
  private closeAllOpenTools(
    scope: TranscriptScope,
    endArgs: { endTime: number } | undefined,
  ): void {
    for (const [callId, entry] of scope.openTools) {
      try {
        entry.span.log({
          metadata: { tool_approval: "approved" },
          error: MISSING_TOOL_OUTPUT_ERROR,
        });
        entry.span.end(endArgs);
      } catch (err) {
        this.logger.error("codex processor: failed to end dangling tool span", {
          queueId: this.queueId,
          callId,
          error: String(err),
        });
      }
    }
    scope.openTools.clear();
  }

  // The most recently opened turn that is still open in this scope (used to
  // attach a user_message or an LLM span, which carry no turn_id).
  private latestOpenTurn(scope: TranscriptScope): OpenTurn | undefined {
    let last: OpenTurn | undefined;
    for (const turn of scope.openTurns.values()) last = turn;
    return last;
  }

  // The start time (Unix seconds) to use for an LLM span opening now under the
  // given turn: the end of the turn's most recently-ended child if any, else the
  // turn's own start. This makes the LLM span cover request->response (the
  // transcript has no record at request-send time) and lets consecutive children
  // tile the turn. Per-turn state, so concurrent subagents never interfere.
  private llmStartTimeFor(turn: OpenTurn): number | undefined {
    return turn.lastChildEndTime ?? turn.startTime;
  }

  // Record that a child of the given turn ended at `endTime`, advancing the
  // turn's lastChildEndTime so the next LLM span starts where this child ended.
  // No-op when endTime is unknown or the turn isn't open.
  private noteChildEnded(
    scope: TranscriptScope,
    turnId: string | undefined,
    endTime: number | undefined,
  ): void {
    if (turnId === undefined || endTime === undefined) return;
    const turn = scope.openTurns.get(turnId);
    if (turn === undefined) return;
    if (turn.lastChildEndTime === undefined || endTime > turn.lastChildEndTime) {
      turn.lastChildEndTime = endTime;
    }
  }

  // The turn_id of the most recently opened still-open turn in this scope.
  private latestOpenTurnId(scope: TranscriptScope): string | undefined {
    let last: string | undefined;
    for (const turnId of scope.openTurns.keys()) last = turnId;
    return last;
  }

  // Number of turns (across all scopes) whose Stop has fired but which are still
  // open (awaiting their task_complete). flush() polls only while this is > 0.
  private countPendingTurns(): number {
    let n = 0;
    for (const scope of this.scopes.values()) {
      for (const turnId of scope.turnsAwaitingCompletion) {
        if (scope.openTurns.has(turnId)) n += 1;
      }
    }
    return n;
  }

  // End the root span on the first main-session Stop. Subsequent Stops are
  // ignored (the SDK records a span's end time once). `endTime` is the completing
  // turn's end time so the root isn't stamped with a late wall-clock value; falls
  // back to the SDK's now() if unknown. Any still-open spans in the main scope
  // are closed at the same time so nothing dangles.
  private endRootSpan(endTime: number | undefined): void {
    if (this.rootSpan === null || this.rootEnded) return;
    this.rootEnded = true;
    this.rootEndTime = endTime;
    const endArgs = endTime !== undefined ? { endTime } : undefined;
    const scope = this.mainScope;
    // Backstop: close any open LLM span, any still-open tool spans, then any
    // still-open turn spans in the main scope, so nothing dangles.
    if (scope !== null) {
      this.endOpenLlmSpan(scope, endTime);
      this.closeAllOpenTools(scope, endArgs);
      for (const [turnId, turn] of scope.openTurns) {
        try {
          turn.span.end(endArgs);
        } catch (err) {
          this.logger.error("codex processor: failed to end dangling turn span on root end", {
            queueId: this.queueId,
            turnId,
            error: String(err),
          });
        }
      }
      scope.openTurns.clear();
    }
    try {
      this.rootSpan.end(endArgs);
      this.logger.info("codex processor: ended root span", { queueId: this.queueId });
    } catch (err) {
      this.logger.error("codex processor: failed to end root span", {
        queueId: this.queueId,
        error: String(err),
      });
    }
    // NOTE: we deliberately do NOT delete the snapshot here. Ending the root span
    // means "this turn's Stop fired", not "the session is over" — Codex has no
    // session-end hook, and later turns attach as children of this same root. The
    // snapshot must persist so a restart between turns can resume the session;
    // stale ones are reclaimed by the store's age-based GC.
  }

  async flush(): Promise<void> {
    if (this.rootSpan === null) return;
    // Final catch-up: a turn's task_complete can land slightly after its Stop
    // hook fires, so the Stop's bounded wait may miss it and leave the turn open.
    // flush() happens after the terminal Stop's /flush (and on idle/eviction).
    // Poll every scope's transcript until every open turn has closed (or a
    // bounded timeout elapses), processing new records as they appear. This
    // processes the transcript (it does not unilaterally end spans), staying
    // consistent with "the transcript is the truth".
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
    // Persist state so a future server run can resume this session's trace. Done
    // after the catch-up + flush above so the snapshot reflects the latest
    // offsets and closed spans.
    this.persistState();
  }

  // ==========================================================================
  // State persistence (resume support)
  // ==========================================================================

  // Persist this session's snapshot so a future server run can resume the trace.
  // Best-effort: the store never throws. No-op without a store/session id, or
  // before any root span exists (nothing worth resuming yet).
  //
  // We persist even once the root span has ended. Codex's "Stop" is per-TURN,
  // not per-session (there is no session-end hook), and we end the root on the
  // first Stop — but the session lives on and more turns can follow, each a
  // child of that same (ended) root. So the snapshot must survive past root-end,
  // or a server restart between turns would lose the thread and start a brand-new
  // trace. Stale snapshots from sessions that truly never resume are reclaimed by
  // the store's age-based GC, not by deleting here.
  private persistState(): void {
    if (this.snapshotStore === null || this.queueId === null) return;
    if (this.rootSpan === null) return; // nothing worth resuming yet
    try {
      this.snapshotStore.write(this.queueId, this.serialize());
    } catch (err) {
      this.logger.error("codex processor: failed to serialize state", {
        queueId: this.queueId,
        error: String(err),
      });
    }
  }

  // One-time restore from a snapshot left by a previous server run. Runs lazily
  // on the first event (after reporting is configured, so the span factory and
  // tracing-enabled check are settled). Guarded so it happens at most once.
  private ensureRestored(): void {
    if (this.restoreAttempted) return;
    this.restoreAttempted = true;
    if (this.snapshotStore === null || this.queueId === null) return;
    // If we've already built a root span this run, there's nothing to restore
    // (we're the original processor, not a post-restart one).
    if (this.rootSpan !== null) return;
    const snapshot = this.snapshotStore.read(this.queueId);
    if (snapshot === null) return;
    if (!isCompatibleSnapshot(snapshot, PLUGIN_VERSION)) {
      this.logger.info("codex processor: snapshot version mismatch; starting fresh", {
        queueId: this.queueId,
        snapshotVersion: snapshot.pluginVersion,
        snapshotSchema: snapshot.schemaVersion,
      });
      this.snapshotStore.delete(this.queueId);
      return;
    }
    try {
      this.restore(snapshot);
      this.logger.info("codex processor: restored session state from snapshot", {
        queueId: this.queueId,
        scopes: snapshot.scopes.length,
      });
    } catch (err) {
      this.logger.error("codex processor: failed to restore snapshot; starting fresh", {
        queueId: this.queueId,
        error: String(err),
      });
    }
  }

  // Remember the name/type a span was created (or renamed) with, so it can be
  // re-asserted on rehydration. Returns the span unchanged for call-site
  // convenience.
  private trackSpan(
    span: Span,
    name: string,
    type: SpanRef["type"],
    startTime: number | undefined,
  ): Span {
    this.spanAttrs.set(span.spanId, { name, type, startTime });
    return span;
  }

  // Capture a span's identity plus its remembered name/type/start for the
  // snapshot, so a rehydrated handle keeps them (and isn't re-stamped to the
  // resume time).
  private refFor(span: Span): SpanRef {
    const attrs = this.spanAttrs.get(span.spanId);
    return spanRef(span, attrs?.name, attrs?.type, attrs?.startTime);
  }

  // Build a serializable snapshot of all resumable state. Span handles are
  // captured as identities (spanId/rootSpanId/parents) plus their name/type; the
  // transcript on disk remains the source of truth for content, so nothing here
  // re-derives spans.
  private serialize(): CodexSnapshot {
    const scopes: ScopeSnapshot[] = [];
    for (const scope of this.scopes.values()) {
      scopes.push({
        path: scope.path,
        kind: scope.kind,
        offset: scope.offset,
        openTurns: Array.from(scope.openTurns, ([turnId, turn]) => ({
          turnId,
          span: this.refFor(turn.span),
          startTime: turn.startTime,
          lastChildEndTime: turn.lastChildEndTime,
          explicitSkillNames: turn.explicitSkillNames,
        })),
        turnsAwaitingCompletion: Array.from(scope.turnsAwaitingCompletion),
        conversationHistory: toItemSnapshots(scope.conversationHistory),
        openLlm:
          scope.openLlm === null
            ? null
            : {
                span: this.refFor(scope.openLlm.span),
                turnId: scope.openLlm.turnId,
                output: toItemSnapshots(scope.openLlm.output),
                lastOutputTime: scope.openLlm.lastOutputTime,
                outputPreset: scope.openLlm.outputPreset,
              },
        openTools: Array.from(scope.openTools, ([callId, entry]) => ({
          callId,
          span: this.refFor(entry.span),
          turnId: entry.turnId,
        })),
        model: scope.model,
        lastTurnEndTime: scope.lastTurnEndTime,
        subagentRootSpan:
          scope.subagentRootSpan === null ? null : this.refFor(scope.subagentRootSpan),
        subagentEnded: scope.subagentEnded,
        ...(scope.pendingSubagent !== undefined
          ? {
              pendingSubagent: {
                agentId: scope.pendingSubagent.agentId,
                agentType: scope.pendingSubagent.agentType,
                parent: this.refFor(scope.pendingSubagent.parent),
              },
            }
          : {}),
      });
    }
    return {
      pluginVersion: PLUGIN_VERSION,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      sessionId: this.queueId,
      savedAt: Date.now(),
      reportingConfig: redactReportingConfig(this.reportingConfig),
      rootSpan: this.rootSpan === null ? null : this.refFor(this.rootSpan),
      rootEnded: this.rootEnded,
      rootEndTime: this.rootEndTime,
      rootEnrichment: { ...this.rootEnrichment },
      mainScopePath: this.mainScope?.path ?? null,
      scopes,
      // We deliberately do NOT persist the span-bearing side-maps
      // (spawnTurnSpansBy*, compactionSpansByTurn). They retain references to
      // spans that have since CLOSED, and rehydrating a closed span re-opens it
      // (the SDK stamps a fresh start and no end), producing duplicate, never-
      // closing spans on resume. The only things they enable across a restart are
      // rare in-flight reconciliations (nesting a subagent spawned right before
      // the restart; back-filling a compaction trigger whose hook lands after the
      // restart) — acceptable to lose. The trigger map is plain strings (no span
      // refs), so it's harmless to keep.
      compactionTriggerByTurn: Array.from(this.compactionTriggerByTurn, ([key, value]) => ({
        key,
        value,
      })),
    };
  }

  // Rebuild live state from a snapshot. Span handles are recreated bound to their
  // original ids (so further log()/end() merge into the same rows). Each scope's
  // lazy parent-span resolver is reconstructed the same way newScope/
  // handleSubagentStart do, so subsequent transcript records attach correctly.
  private restore(snapshot: CodexSnapshot): void {
    // Reporting config first: it determines the span factory (project/creds).
    // The snapshot is the source of truth — we adopt it as-is rather than
    // merging in this run's config, so a resume whose env/settings drifted from
    // the original session can't clobber the snapshot's values. The one field
    // the snapshot can't carry is the `apiKey` secret (intentionally never
    // persisted), so we re-attach the live one resolved from this run's config
    // event / env. This must happen before we touch `this.spanFactory`, which is
    // built lazily from `this.reportingConfig`.
    if (snapshot.reportingConfig !== undefined) {
      this.reportingConfig = {
        ...snapshot.reportingConfig,
        apiKey: this.reportingConfig?.apiKey,
      };
    }

    const factory = this.spanFactory;
    // Rehydrate a handle and re-remember its name/type/start, so if this resumed
    // processor is itself snapshotted again, the attributes survive the next hop.
    const rehydrate = (ref: SpanRef): Span => {
      const span = factory.rehydrateSpan(ref);
      if (ref.name !== undefined && ref.type !== undefined) {
        this.spanAttrs.set(span.spanId, {
          name: ref.name,
          type: ref.type,
          startTime: ref.startTime,
        });
      }
      return span;
    };

    this.rootSpan = snapshot.rootSpan === null ? null : rehydrate(snapshot.rootSpan);
    this.rootEnded = snapshot.rootEnded;
    this.rootEndTime = snapshot.rootEndTime;
    this.rootEnrichment = { ...snapshot.rootEnrichment };
    // Rehydrating the root necessarily re-emits its row with no end time. If the
    // root was already ended before the restart, re-assert that end now so it
    // stays closed (a later turn can still attach as a child of an ended root).
    if (this.rootEnded && this.rootSpan !== null) {
      try {
        this.rootSpan.end(
          this.rootEndTime !== undefined ? { endTime: this.rootEndTime } : undefined,
        );
      } catch (err) {
        this.logger.error("codex processor: failed to re-end root span on restore", {
          queueId: this.queueId,
          error: String(err),
        });
      }
    }

    for (const s of snapshot.scopes) {
      const isMain = s.path === snapshot.mainScopePath;
      // The lazy parent resolver mirrors live construction: a main scope's turns
      // hang under the root span; a subagent scope's under its own (restored)
      // subagent root span.
      const scope: TranscriptScope = {
        path: s.path,
        kind: s.kind,
        parentSpan: isMain ? () => this.rootSpan : () => scope.subagentRootSpan,
        offset: s.offset,
        openTurns: new Map(
          s.openTurns.map((t) => [
            t.turnId,
            {
              span: rehydrate(t.span),
              startTime: t.startTime,
              lastChildEndTime: t.lastChildEndTime,
              explicitSkillNames: t.explicitSkillNames ?? [],
            },
          ]),
        ),
        turnsAwaitingCompletion: new Set(s.turnsAwaitingCompletion),
        conversationHistory: fromItemSnapshots(s.conversationHistory),
        openLlm:
          s.openLlm === null
            ? null
            : {
                span: rehydrate(s.openLlm.span),
                turnId: s.openLlm.turnId,
                output: fromItemSnapshots(s.openLlm.output),
                lastOutputTime: s.openLlm.lastOutputTime,
                outputPreset: s.openLlm.outputPreset,
              },
        openTools: new Map(
          s.openTools.map((t) => [t.callId, { span: rehydrate(t.span), turnId: t.turnId }]),
        ),
        model: s.model,
        lastTurnEndTime: s.lastTurnEndTime,
        subagentRootSpan: s.subagentRootSpan === null ? null : rehydrate(s.subagentRootSpan),
        subagentEnded: s.subagentEnded,
        ...(s.pendingSubagent !== undefined
          ? {
              pendingSubagent: {
                agentId: s.pendingSubagent.agentId,
                agentType: s.pendingSubagent.agentType,
                parent: rehydrate(s.pendingSubagent.parent),
              },
            }
          : {}),
      };
      this.scopes.set(s.path, scope);
      if (isMain) this.mainScope = scope;
    }

    // Span-bearing side-maps (spawnTurnSpansBy*, compactionSpansByTurn) are not
    // persisted — see serialize() — so there is nothing to rehydrate for them,
    // which is what keeps a resume from re-opening already-closed spans. Only the
    // plain-string trigger map is restored.
    for (const e of snapshot.compactionTriggerByTurn) {
      this.compactionTriggerByTurn.set(e.key, e.value);
    }
  }

  // Read and process new transcript records for every scope, retrying on a
  // bounded interval, until no turn that has seen its Stop is still open (its
  // task_complete can land seconds after the Stop hook) or the timeout elapses.
  // Always does at least one read so a task_complete already on disk closes its
  // turn immediately. Crucially, this does NOT wait for turns that are merely
  // mid-progress (no Stop yet) — so an idle flush during an active turn returns
  // promptly. On timeout, leaves whatever is still open for the backstops.
  private async drainOpenTurns(): Promise<void> {
    if (this.scopes.size === 0) return;
    const deadline = Date.now() + FLUSH_TIMEOUT_MS;
    for (;;) {
      for (const scope of this.scopes.values()) {
        // A finalized subagent scope is inert: re-reading it would re-open spans
        // that were already closed (and the SDK would overwrite the closed spans
        // with un-ended ones). Skip it.
        if (scope.subagentEnded) continue;
        try {
          const { lines, offset } = this.transcriptReader.readFrom(scope.path, scope.offset);
          scope.offset = offset;
          this.consumeLines(scope, lines);
        } catch (err) {
          this.logger.error("codex processor: final catch-up read failed", {
            queueId: this.queueId,
            path: scope.path,
            error: String(err),
          });
        }
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
