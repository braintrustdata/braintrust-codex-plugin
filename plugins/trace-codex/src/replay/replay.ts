// Replay a recorded session: read an NDJSON file of raw EnqueueEvents and POST
// each one, in order, to a running event server (booting one if needed). This
// exercises the full real pipeline (queue -> registry -> processors -> spans),
// reproducing the original session's trace.

import { readFile } from "node:fs/promises";
import { checkHealth, ensureServer, sleep } from "../client/ensure-server.ts";
import { spawnServer } from "../client/spawn-server.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import { postEnqueue } from "../server/enqueue-client.ts";
import type { EnqueueEvent } from "../server/routes.ts";

/** Parse NDJSON text into events, skipping blank/malformed lines. */
export function parseRecording(text: string, logger?: Logger): EnqueueEvent[] {
  const events: EnqueueEvent[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line) as EnqueueEvent);
    } catch (err) {
      logger?.warn("replay: skipping malformed line", {
        lineNumber: i + 1,
        error: String(err),
      });
    }
  }
  return events;
}

export interface ReplayResult {
  total: number;
  sent: number;
  failed: number;
}

/**
 * Read the recording at `filePath`, ensure the server is up, and POST each
 * event in order. Returns a summary. Never throws.
 */
export async function runReplay(
  config: Config,
  logger: Logger,
  filePath: string,
): Promise<ReplayResult> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    logger.error("replay: could not read recording file", {
      filePath,
      error: String(err),
    });
    return { total: 0, sent: 0, failed: 0 };
  }

  const events = parseRecording(text, logger);
  if (events.length === 0) {
    logger.warn("replay: no events to replay", { filePath });
    return { total: 0, sent: 0, failed: 0 };
  }

  const healthy = await ensureServer({ config, logger, checkHealth, spawn: spawnServer, sleep });
  if (!healthy) {
    logger.error("replay: could not reach or start event server", { filePath });
    return { total: events.length, sent: 0, failed: events.length };
  }

  let sent = 0;
  let failed = 0;
  // Sequential POSTs preserve per-session ordering on the queue.
  for (const event of events) {
    const ok = await postEnqueue(config, event, logger);
    if (ok) sent++;
    else failed++;
  }

  logger.info("replay complete", { filePath, total: events.length, sent, failed });
  return { total: events.length, sent, failed };
}
