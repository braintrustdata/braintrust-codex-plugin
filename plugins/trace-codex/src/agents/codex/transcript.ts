// Pure parser/types for Codex transcript ("rollout") records.
//
// Codex writes an append-only JSONL transcript per session at the path every
// hook payload reports as `transcript_path`. Each line is one record with a
// stable envelope: `{ timestamp, type, payload }`. The transcript is the only
// source for LLM calls, token usage, and the true execution order of LLM and
// tool calls within a turn.
//
// This module only parses lines into typed records; it builds no spans and has
// no Braintrust dependency. The format is explicitly NOT a stable interface
// (Codex may change it across versions), so parsing is permissive and
// fail-soft: unknown record types are preserved as-is, and a malformed line
// yields null rather than throwing.

/**
 * The common envelope every transcript line shares. `payload` is intentionally
 * loose: we narrow it per `type`/`payload.type` only where we need to, and we
 * tolerate shapes we don't recognize.
 */
export interface TranscriptRecord {
  /** ISO-8601 timestamp Codex wrote the record (its clock). */
  timestamp?: string;
  /** Top-level record kind, e.g. "response_item", "event_msg", "turn_context". */
  type?: string;
  /** Record-specific body. Narrow via `payload.type` for response_item/event_msg. */
  payload?: TranscriptPayload;
  /** Anything else Codex includes; preserved for forward compatibility. */
  [key: string]: unknown;
}

/** Loose payload shape. `type` discriminates response_item / event_msg subtypes. */
export interface TranscriptPayload {
  type?: string;
  [key: string]: unknown;
}

// Known top-level record types. Kept as constants (not a closed union) so
// unknown types still parse and flow through as plain records.
export const RECORD_SESSION_META = "session_meta";
export const RECORD_TURN_CONTEXT = "turn_context";
export const RECORD_RESPONSE_ITEM = "response_item";
export const RECORD_EVENT_MSG = "event_msg";
export const RECORD_COMPACTED = "compacted";

// Known response_item payload subtypes.
export const ITEM_MESSAGE = "message";
export const ITEM_REASONING = "reasoning";
export const ITEM_FUNCTION_CALL = "function_call";
export const ITEM_FUNCTION_CALL_OUTPUT = "function_call_output";
export const ITEM_CUSTOM_TOOL_CALL = "custom_tool_call";
export const ITEM_CUSTOM_TOOL_CALL_OUTPUT = "custom_tool_call_output";
export const ITEM_TOOL_SEARCH_CALL = "tool_search_call";
export const ITEM_TOOL_SEARCH_OUTPUT = "tool_search_output";

// Known event_msg payload subtypes.
export const EVT_TOKEN_COUNT = "token_count";
export const EVT_AGENT_MESSAGE = "agent_message";
export const EVT_USER_MESSAGE = "user_message";
export const EVT_TASK_STARTED = "task_started";
export const EVT_TASK_COMPLETE = "task_complete";
export const EVT_CONTEXT_COMPACTED = "context_compacted";

/**
 * Parse a single transcript line into a TranscriptRecord. Returns null for
 * blank lines and for anything that isn't a JSON object, so callers can skip it
 * without breaking the session. Never throws.
 */
export function parseTranscriptLine(line: string): TranscriptRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as TranscriptRecord;
  } catch {
    // Malformed JSON (e.g. a partially-written line): skip it.
    return null;
  }
}
