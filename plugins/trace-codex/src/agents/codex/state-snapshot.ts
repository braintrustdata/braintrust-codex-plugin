// Serializable snapshot of a CodexEventProcessor's resumable state.
//
// The processor builds a session's trace incrementally, holding all its
// bookkeeping in memory: where it is in each transcript file (byte offsets),
// which spans are still open (and their identities), the reconstructed
// conversation history used to shape LLM-call inputs, and a few side-maps that
// reconcile hook-only data with the transcript. The rollout transcript on disk
// is the durable source of truth for span *content*; this snapshot captures only
// the bookkeeping needed to pick up exactly where a previous run left off.
//
// The server is short-lived: it shuts down after an idle window (default 5 min)
// or when the user closes the session, and a later hook (a "resume", or just the
// next turn) spins up a fresh processor for the same session id. Without a
// snapshot that processor would re-read the transcript from zero with brand-new
// span ids, producing duplicate/orphaned spans. With one, it rehydrates the
// original spans (via {@link SpanFactory.rehydrateSpan}) and continues, so every
// further log()/end() merges into the same trace.
//
// This module defines the snapshot *shape* and pure mapping helpers only; the
// processor owns turning its live state (which holds Span handles) into a
// snapshot and back, since that needs the span factory. Span handles are stored
// here as {@link SpanRef} identities (span_id/root_span_id/parents), captured
// from the synchronous getters on a live span.

import type { ReportingConfig, SpanRef } from "../../braintrust/logger.ts";

/**
 * Bumped whenever the snapshot shape changes incompatibly. A snapshot whose
 * schemaVersion doesn't match is discarded on load (the session simply starts
 * fresh, losing only resume continuity), so we never try to rehydrate state we
 * can't interpret.
 */
export const SNAPSHOT_SCHEMA_VERSION = 4;

/** A conversation item (chat message or reasoning), stored verbatim. These are
 * plain JSON already, so they round-trip without transformation. */
export type ConversationItemSnapshot = Record<string, unknown>;

/** An open LLM span and the output items accumulated for it so far. */
export interface OpenLlmSnapshot {
  span: SpanRef;
  turnId: string | undefined;
  output: ConversationItemSnapshot[];
  /** Time (Unix seconds) of the call's last model-output item; the span's end. */
  lastOutputTime: number | undefined;
  outputPreset?: boolean;
}

/** An open tool span and the turn it belongs to (keyed by call_id in the map). */
export interface OpenToolSnapshot {
  callId: string;
  span: SpanRef;
  turnId: string;
}

/** An open turn span (keyed by turn_id in the map), plus the timing used to
 * place its child LLM spans. */
export interface OpenTurnSnapshot {
  turnId: string;
  span: SpanRef;
  /** Turn start (Unix seconds), used as the first child's start time. */
  startTime: number | undefined;
  /** Max end time (Unix seconds) among the turn's already-ended children. */
  lastChildEndTime: number | undefined;
  /** Explicit skill names requested by the user for this turn. */
  explicitSkillNames?: string[];
}

/** Pending-subagent info captured before its root span exists. The parent turn
 * span is referenced by identity so it can be rehydrated independently. */
export interface PendingSubagentSnapshot {
  agentId: string;
  agentType: string | undefined;
  parent: SpanRef;
}

/** One transcript file's parsing state. Mirrors TranscriptScope, with Span
 * handles replaced by SpanRef identities. */
export interface ScopeSnapshot {
  path: string;
  kind: "main" | "subagent";
  offset: number;
  openTurns: OpenTurnSnapshot[];
  turnsAwaitingCompletion: string[];
  conversationHistory: ConversationItemSnapshot[];
  openLlm: OpenLlmSnapshot | null;
  openTools: OpenToolSnapshot[];
  model: string | undefined;
  lastTurnEndTime: number | undefined;
  subagentRootSpan: SpanRef | null;
  subagentEnded: boolean;
  pendingSubagent?: PendingSubagentSnapshot;
}

/** A side-map entry pairing a key with a string value. */
export interface StringMapEntry {
  key: string;
  value: string;
}

/** The full resumable state of a CodexEventProcessor. */
export interface CodexSnapshot {
  /** Plugin version that wrote this snapshot; discarded on mismatch. */
  pluginVersion: string;
  /** Snapshot shape version; discarded on mismatch. */
  schemaVersion: number;
  /** Session id (queueId) this snapshot belongs to. */
  sessionId: string | null;
  /** Wall-clock ms when written, for age-based GC of orphans. */
  savedAt: number;

  /**
   * Reporting config, minus secrets. `apiKey` is intentionally never persisted
   * (re-resolved from the env / config event on resume), mirroring how the event
   * recorder redacts it.
   */
  reportingConfig: Omit<ReportingConfig, "apiKey"> | undefined;

  rootSpan: SpanRef | null;
  rootEnded: boolean;
  /** When the root was ended (Unix seconds), if it has been; re-asserted on
   * resume so the rehydrated root row stays closed. */
  rootEndTime: number | undefined;
  rootEnrichment: { source?: string; permissionMode?: string };

  /** Path of the main scope within `scopes`, if it exists. */
  mainScopePath: string | null;
  scopes: ScopeSnapshot[];

  /**
   * Compaction triggers ("manual"/"auto") keyed by turn_id. Plain strings (no
   * span references), so safe to carry across a restart. The span-bearing
   * side-maps (spawn-agent turn spans, compaction spans) are deliberately NOT
   * persisted: they hold references to spans that may have closed, and
   * rehydrating a closed span re-opens it.
   */
  compactionTriggerByTurn: StringMapEntry[];
}

/** A parsed snapshot is usable only if it matches our plugin + schema version. */
export function isCompatibleSnapshot(snapshot: CodexSnapshot, pluginVersion: string): boolean {
  return (
    snapshot.schemaVersion === SNAPSHOT_SCHEMA_VERSION && snapshot.pluginVersion === pluginVersion
  );
}

/** Strip the apiKey from a reporting config before persisting it. */
export function redactReportingConfig(
  config: ReportingConfig | undefined,
): Omit<ReportingConfig, "apiKey"> | undefined {
  if (config === undefined) return undefined;
  const { apiKey: _apiKey, ...rest } = config;
  return rest;
}
