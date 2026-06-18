// Records every dequeued event as newline-delimited JSON to a file, for later
// `replay`. Each line is a raw EnqueueEvent — exactly what was POSTed to
// /enqueue — so replay is symmetric and faithful to production.
//
// The file is truncated when the recorder opens (one server run = one capture).
// Like the logger, the recorder never throws: a recording failure must not be
// able to break the event pipeline.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../log.ts";
import type { EnqueueEvent } from "./routes.ts";

/** eventData keys that hold secrets and must never be written to a recording. */
const REDACTED_KEYS = ["apiKey"];
const REDACTED = "__redacted__";

/**
 * Return a copy of the event safe to persist: any secret fields in eventData
 * (e.g. a config event's apiKey) are replaced with a redaction marker so
 * recordings never contain credentials. Replay still works — the redacted key
 * just lacks the secret, which the server re-resolves from env anyway.
 */
export function redactForRecording(event: EnqueueEvent): EnqueueEvent {
  const data = event.eventData;
  if (typeof data !== "object" || data === null) return event;
  const obj = data as Record<string, unknown>;
  let redacted: Record<string, unknown> | undefined;
  for (const key of REDACTED_KEYS) {
    if (key in obj && obj[key] !== undefined) {
      redacted ??= { ...obj };
      redacted[key] = REDACTED;
    }
  }
  return redacted ? { ...event, eventData: redacted } : event;
}

export class EventRecorder {
  private readonly filePath: string;
  private readonly logger: Logger;
  private enabled = true;

  constructor(filePath: string, logger: Logger) {
    this.filePath = filePath;
    this.logger = logger;
    // Truncate on open: each server run starts a fresh capture.
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "");
      this.logger.info("recording events", { recordFile: filePath });
    } catch (err) {
      // Disable so we don't spam per-event errors for a path we can't write.
      this.enabled = false;
      this.logger.error("recorder: could not open record file; recording off", {
        recordFile: filePath,
        error: String(err),
      });
    }
  }

  /** Append one event as a JSON line. Never throws. */
  record(event: EnqueueEvent): void {
    if (!this.enabled) return;
    try {
      appendFileSync(this.filePath, `${JSON.stringify(redactForRecording(event))}\n`);
    } catch (err) {
      this.logger.error("recorder: write failed", {
        recordFile: this.filePath,
        error: String(err),
      });
    }
  }
}
