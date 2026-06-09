// HTTP route handlers. Pure-ish: they take state + deps and return a Response,
// plus optionally signal that a shutdown was requested.

import type { Logger } from "../log.ts";
import type { EventQueue } from "./event-queue.ts";
import type { ServerState } from "./state.ts";

/** Shape of the body POSTed to /enqueue. */
export interface EnqueueEvent {
  /**
   * Correlation key for this event stream (the Codex session id), or null if
   * the source could not determine one. Events without a queueId are still
   * accepted; the consumer logs a warning.
   */
  queueId: string | null;
  /** Where the event came from, e.g. "codex-hook". */
  eventSource: string;
  /** Version of that source, or null if unknown. */
  eventSourceVersion: string | null;
  /** The lifecycle event name, e.g. "UserPromptSubmit". */
  eventName: string;
  /** Raw event payload from the source. */
  eventData: unknown;
}

export interface RouteDeps {
  state: ServerState;
  logger: Logger;
  /** Queue that /enqueue pushes events onto. */
  queue: EventQueue;
  /** Invoked when /shutdown is hit, after the response is constructed. */
  onShutdownRequested: () => void;
}

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SERVICE_UNAVAILABLE = () => json({ error: "shutting_down" }, 503);

/** Max time /flush waits for the queue to drain before giving up. */
const FLUSH_TIMEOUT_MS = 10_000;

export async function handleRequest(req: Request, deps: RouteDeps): Promise<Response> {
  const { state, logger, queue, onShutdownRequested } = deps;
  const url = new URL(req.url);
  const path = url.pathname;

  if (state.isShuttingDown()) return SERVICE_UNAVAILABLE();

  // Any request counts as activity.
  state.bump();

  // GET /health
  if (path === "/health" && req.method === "GET") {
    return json({ version: state.version });
  }

  // POST /enqueue
  if (path === "/enqueue" && req.method === "POST") {
    if (state.isShuttingDown()) return SERVICE_UNAVAILABLE();

    let event: EnqueueEvent;
    try {
      event = (await req.json()) as EnqueueEvent;
    } catch {
      logger.warn("enqueue: invalid JSON body");
      return json({ error: "invalid_json" }, 400);
    }

    if (!isValidEnqueueEvent(event)) {
      logger.warn("enqueue: invalid event shape", { received: event });
      return json({ error: "invalid_event" }, 400);
    }

    // Push onto the background queue and return immediately; the consumer
    // handles processing.
    queue.enqueue(event);
    return json({ ok: true });
  }

  // POST /flush
  // Wait until everything enqueued so far has been processed and buffered spans
  // have been flushed to the backend, then respond. Used by the hook client on
  // terminal events (e.g. Codex "Stop") so the final spans are delivered before
  // the process tree is torn down — important in short-lived environments like
  // CI where the background server won't survive to flush on idle.
  if (path === "/flush" && req.method === "POST") {
    const flushed = await Promise.race([
      queue.drained().then(() => true),
      // Bound the wait so a hung backend flush can't hold the request lock (and
      // thus block the idle watchdog and other requests) indefinitely.
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), FLUSH_TIMEOUT_MS)),
    ]);
    if (!flushed) {
      logger.warn("flush timed out waiting for queue to drain");
      return json({ ok: false, timedOut: true }, 200);
    }
    return json({ ok: true });
  }

  // POST /shutdown
  if (path === "/shutdown" && req.method === "POST") {
    state.beginShutdown();
    logger.info("shutdown requested");
    // Defer the actual stop briefly so this 200 response is fully flushed to
    // the client before the server closes its listener.
    setTimeout(onShutdownRequested, 50);
    return new Response(null, { status: 200 });
  }

  return json({ error: "not_found" }, 404);
}

function isValidEnqueueEvent(value: unknown): value is EnqueueEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (typeof v.queueId === "string" || v.queueId === null) &&
    typeof v.eventSource === "string" &&
    (typeof v.eventSourceVersion === "string" || v.eventSourceVersion === null) &&
    typeof v.eventName === "string" &&
    "eventData" in v
  );
}
