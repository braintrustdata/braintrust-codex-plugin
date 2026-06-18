// Translates a raw Codex hook payload (the JSON Codex writes to the hook's
// stdin) into one or more generic EnqueueEvents. This is the Codex-specific half
// of the client; the generic run loop (ensure server, POST) lives in src/client.

import type { ReportingConfig } from "../../braintrust/logger.ts";
import type { EnqueueEvent } from "../../server/routes.ts";

/** Identifies events originating from the Codex hook. */
export const CODEX_EVENT_SOURCE = "codex-hook";

/**
 * Internal, synthetic event emitted (with the session's queueId) ahead of a
 * SessionStart. It carries the resolved Braintrust reporting config so the
 * per-session processor can build its own logger before opening any spans.
 * Prefixed to avoid clashing with real Codex hook_event_name values.
 */
export const CODEX_CONFIG_EVENT = "__braintrust_config";

/** Parse a boolean env var: true only for "true"/"1" (case-insensitive). */
function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1";
}

/** Resolve the reporting config from the (already settings-applied) environment. */
export function resolveReportingConfig(env: NodeJS.ProcessEnv = process.env): ReportingConfig {
  const config: ReportingConfig = {};
  if (env.BRAINTRUST_PROJECT) config.project = env.BRAINTRUST_PROJECT;
  else if (env.BRAINTRUST_DEFAULT_PROJECT) config.project = env.BRAINTRUST_DEFAULT_PROJECT;
  if (env.BRAINTRUST_API_KEY) config.apiKey = env.BRAINTRUST_API_KEY;
  if (env.BRAINTRUST_API_URL) config.apiUrl = env.BRAINTRUST_API_URL;
  if (env.BRAINTRUST_APP_URL) config.appUrl = env.BRAINTRUST_APP_URL;

  // Master switch: off unless explicitly enabled.
  config.traceToBraintrust = parseBoolEnv(env.TRACE_TO_BRAINTRUST);

  // Additional metadata: a JSON object. Ignore anything that isn't one.
  const rawMeta = env.BRAINTRUST_ADDITIONAL_METADATA;
  if (rawMeta) {
    try {
      const parsed = JSON.parse(rawMeta);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        config.additionalMetadata = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed: ignore rather than break the session.
    }
  }
  return config;
}

/** Build the synthetic config event for a session. */
export function buildConfigEvent(
  queueId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): EnqueueEvent {
  return {
    queueId,
    eventSource: CODEX_EVENT_SOURCE,
    eventSourceVersion: env.CODEX_VERSION ?? null,
    eventName: CODEX_CONFIG_EVENT,
    eventData: resolveReportingConfig(env),
  };
}

/**
 * Build the enqueue payload(s) from the raw Codex hook event JSON.
 *
 * Returns an array: normally a single event, but on SessionStart a leading
 * config event (same queueId) is prepended so the processor configures its
 * reporting before opening the root span.
 *
 * The queue is keyed by the Codex session id. We always forward the event so it
 * lands in the background queue; if there is no usable `session_id`, `queueId`
 * is left null and the server-side consumer logs a warning.
 */
export function buildEnqueueEvents(
  rawStdin: string,
  env: NodeJS.ProcessEnv = process.env,
): EnqueueEvent[] {
  let eventData: unknown = null;
  let eventName = "unknown";
  let queueId: string | null = null;
  try {
    const parsed = JSON.parse(rawStdin) as Record<string, unknown>;
    eventData = parsed;
    if (typeof parsed.hook_event_name === "string") {
      eventName = parsed.hook_event_name;
    }
    if (typeof parsed.session_id === "string" && parsed.session_id.length > 0) {
      queueId = parsed.session_id;
    }
  } catch {
    // Still forward the raw text for debugging.
    eventData = { raw: rawStdin };
  }

  const event: EnqueueEvent = {
    queueId,
    eventSource: CODEX_EVENT_SOURCE,
    eventSourceVersion: env.CODEX_VERSION ?? null,
    eventName,
    eventData,
  };

  // On session start, prepend the config event so the processor can configure
  // its per-session reporting before the root span is created.
  if (eventName === "SessionStart") {
    return [buildConfigEvent(queueId, env), event];
  }
  return [event];
}
