// Long-lived background HTTP server ("serve" mode).

import { defaultSpanFactoryProvider } from "../braintrust/logger.ts";
import type { Config } from "../config.ts";
import { createLogger, type Logger } from "../log.ts";
import type { EventProcessorFactory } from "../processor/event-processor.ts";
import { ProcessorRegistry } from "../processor/processor-registry.ts";
import { PLUGIN_VERSION } from "../version.ts";
import { EventQueue } from "./event-queue.ts";
import { Mutex } from "./mutex.ts";
import { EventRecorder } from "./recorder.ts";
import { handleRequest } from "./routes.ts";
import { ServerState } from "./state.ts";

export interface RunningServer {
  port: number;
  state: ServerState;
  stop(): Promise<void>;
  /** Resolves when the server has fully stopped (idle, /shutdown, or stop()). */
  done: Promise<void>;
}

/**
 * Starts the event server. Throws if the port is already bound.
 *
 * `factories` maps each supported event source to its processor factory (one per
 * agent). The server stays agent-agnostic and just forwards them to the
 * ProcessorRegistry.
 */
export function startServer(
  config: Config,
  factories: Map<string, EventProcessorFactory>,
  logger?: Logger,
): RunningServer {
  const log = logger ?? createLogger({ dataDir: config.dataDir, component: "server" });
  const state = new ServerState(PLUGIN_VERSION);

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  // Serialize request handling so only one handleRequest runs at a time, end to
  // end, even across `await` points. This makes read-modify-write of shared
  // server state safe without per-field guards.
  const requestLock = new Mutex();

  // Background queue + consumer. Each event is routed to a per-session
  // EventProcessor by the registry. When the queue drains to empty, flush all
  // processors so buffered spans reach Braintrust promptly.
  const registry = new ProcessorRegistry(log, factories, {
    spanFactoryProvider: defaultSpanFactoryProvider,
  });
  // Optional recorder: if configured, capture every dequeued event (all
  // sources, all sessions) before routing it, for later `replay`.
  const recorder = config.recordFile ? new EventRecorder(config.recordFile, log) : undefined;
  const queue = new EventQueue({
    logger: log,
    handler: (event) => {
      // Pulling an event off the queue counts as activity, so a slow consumer
      // (e.g. a slow Braintrust flush) doesn't let the idle watchdog tear the
      // server down while events are still being drained.
      state.bump();
      recorder?.record(event);
      return registry.handle(event);
    },
    onIdle: () => registry.flushAll(),
  });
  queue.start();

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (idleTimer) clearInterval(idleTimer);
    state.beginShutdown();
    // Graceful stop: stop accepting new connections and let in-flight requests
    // (e.g. the /shutdown response itself) finish before closing.
    await server.stop();
    // Drain the queue: process whatever was already enqueued, then exit.
    await queue.stop();
    // End all sessions (finalize + flush their root spans) before we exit.
    await registry.closeAll();
    log.info("server stopped", { port: config.port });
    resolveDone();
  };

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // Surface listen errors as a thrown exception from Bun.serve.
    // Every request is serialized through requestLock so handlers never
    // interleave with each other.
    fetch: (req) =>
      requestLock.runExclusive(() =>
        handleRequest(req, {
          state,
          logger: log,
          queue,
          onShutdownRequested: () => {
            void stop();
          },
        }),
      ),
    error: (err) => {
      log.error("request error", { error: String(err) });
      return new Response(JSON.stringify({ error: "internal" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
  });

  // Idle watchdog: shut down after inactivity. The check-and-shutdown runs
  // through the same lock as request handlers, so it cannot observe staleness
  // or tear the server down while a request is mid-flight. If a request is
  // queued/running, the watchdog waits its turn; by then the request has bumped
  // the heartbeat, so this pass sees the server as active and does nothing.
  idleTimer = setInterval(() => {
    void requestLock.runExclusive(() => {
      if (state.isShuttingDown()) return;
      if (state.isIdleExpired(config.idleTimeoutMs)) {
        log.info("idle timeout reached, shutting down", {
          idleTimeoutMs: config.idleTimeoutMs,
        });
        void stop();
      }
    });
  }, config.idleCheckIntervalMs);
  // Don't let the watchdog keep the process alive on its own.
  idleTimer.unref?.();

  log.info("server started", {
    version: PLUGIN_VERSION,
    host: config.host,
    port: server.port,
  });

  return { port: server.port ?? config.port, state, stop, done };
}
