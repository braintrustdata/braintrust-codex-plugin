// Hook client run loop ("hook" mode, the default): read the agent's event from
// stdin, ensure the server is up, POST it to /enqueue, and exit.
//
// This is agent-agnostic: the caller supplies a `buildEvent` function that knows
// how to translate the agent's raw stdin payload into a generic EnqueueEvent.
//
// Hard rule: this must NEVER throw out to the process in a way that fails the
// agent's turn. All errors are logged and swallowed; we always exit 0.

import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import { postEnqueue, postFlush } from "../server/enqueue-client.ts";
import type { EnqueueEvent } from "../server/routes.ts";
import { checkHealth, ensureServer, sleep } from "./ensure-server.ts";
import { spawnServer } from "./spawn-server.ts";

/**
 * Translates an agent's raw stdin payload into one or more generic
 * EnqueueEvents. Most events map to a single event; some (e.g. a session start)
 * also emit a leading config event. The events are POSTed in array order, so
 * ordering-sensitive events (config before session start) come first.
 */
export type EventBuilder = (rawStdin: string, env?: NodeJS.ProcessEnv) => EnqueueEvent[];

/** Read all of stdin as a string. */
async function readStdin(): Promise<string> {
  try {
    return await Bun.stdin.text();
  } catch {
    return "";
  }
}

export interface HookClientOptions {
  /**
   * Event names that terminate a turn/session. After enqueuing one of these,
   * the client asks the server to flush (POST /flush) so buffered spans are
   * delivered. Defaults to none (fire-and-forget).
   */
  terminalEvents?: readonly string[];
  /**
   * Whether the terminal-event flush blocks until the server confirms all
   * events are processed and spans are delivered (block=true), versus a
   * fire-and-forget signal that returns immediately (block=false). Defaults to
   * false; set true (via BRAINTRUST_PLUGIN_BLOCK_ON_STOP) to guarantee delivery
   * before Codex exits, e.g. in programmatic/CI runs.
   */
  blockOnStop?: boolean;
}

export async function runHookClient(
  config: Config,
  logger: Logger,
  buildEvents: EventBuilder,
  options: HookClientOptions = {},
): Promise<void> {
  const rawStdin = await readStdin();
  const events = buildEvents(rawStdin);
  if (events.length === 0) return;

  const terminalEvents = new Set(options.terminalEvents ?? []);

  const healthy = await ensureServer({
    config,
    logger,
    checkHealth,
    spawn: spawnServer,
    sleep,
  });

  if (!healthy) {
    logger.error("could not reach or start event server; dropping events", {
      count: events.length,
    });
    return;
  }

  // POST in order so a leading config event is enqueued before the event it
  // configures (the FIFO consumer then sees config first).
  let sawTerminal = false;
  for (const event of events) {
    const ok = await postEnqueue(config, event, logger);
    if (ok) {
      logger.debug("event enqueued", { eventName: event.eventName });
      if (terminalEvents.has(event.eventName)) sawTerminal = true;
    }
  }

  // On a terminal event, flush. When blockOnStop is set, block until the server
  // confirms the queue has drained and buffered spans are delivered — important
  // for a CI job (or any short-lived host) that ends right after the agent's
  // last turn, before the background server's idle timeout fires, which would
  // otherwise lose the final spans. Otherwise fire-and-forget so the turn isn't
  // stalled; the background server delivers spans on its own.
  if (sawTerminal) {
    const block = options.blockOnStop ?? false;
    const flushed = await postFlush(config, logger, { block });
    logger.debug("flush requested on terminal event", { flushed, block });
  }
}
