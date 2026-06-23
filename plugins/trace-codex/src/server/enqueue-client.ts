// Shared HTTP client for POSTing an event to a running server's /enqueue.
// Used by the hook client and by replay.

import type { Config } from "../config.ts";
import { serverBaseUrl } from "../config.ts";
import type { Logger } from "../log.ts";
import type { EnqueueEvent } from "./routes.ts";

/** POST one event to /enqueue. Returns true on a 2xx response. Never throws. */
export async function postEnqueue(
  config: Pick<Config, "host" | "port">,
  event: EnqueueEvent,
  logger: Logger,
): Promise<boolean> {
  try {
    const res = await fetch(`${serverBaseUrl(config)}/enqueue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      logger.warn("enqueue rejected", { status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    logger.error("enqueue request failed", { error: String(err) });
    return false;
  }
}

/**
 * Ask the server to flush, blocking until it confirms. Returns true on a 2xx
 * response. Never throws.
 *
 * The server waits until everything enqueued so far has been processed and
 * buffered spans have reached the backend before responding. The hook uses this
 * after a terminal event (only when block-on-stop is configured) so the final
 * spans are delivered before the process tree is torn down (e.g. a CI job ending
 * right after the agent's last turn, before the idle timeout fires).
 */
export async function postFlush(
  config: Pick<Config, "host" | "port">,
  logger: Logger,
): Promise<boolean> {
  try {
    const res = await fetch(`${serverBaseUrl(config)}/flush`, {
      method: "POST",
      // The server bounds its wait by FLUSH_TIMEOUT_MS; allow a little more here
      // so we receive its response rather than aborting first.
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      logger.warn("flush rejected", { status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    logger.error("flush request failed", { error: String(err) });
    return false;
  }
}
