// Long-lived background HTTP server ("serve" mode).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
  /**
   * Bound port. Equals config.port when a concrete port is configured; when
   * config.port is 0 (ephemeral), it is updated to the OS-assigned port once
   * `ready` resolves.
   */
  port: number;
  /** Resolves with the bound port once the server is listening. */
  ready: Promise<number>;
  state: ServerState;
  stop(): Promise<void>;
  /** Resolves when the server has fully stopped (idle, /shutdown, or stop()). */
  done: Promise<void>;
}

/**
 * Collect a Node request into a WHATWG Request so the route handlers can stay
 * Fetch-based (Request in, Response out) regardless of the HTTP runtime.
 */
async function toWebRequest(req: IncomingMessage, fallbackHost: string): Promise<Request> {
  const method = req.method ?? "GET";
  const host = req.headers.host ?? fallbackHost;
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  // A GET/HEAD Request must not carry a body (the constructor throws otherwise).
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  return new Request(url, { method, headers, body });
}

/** Write a WHATWG Response back onto the Node response object. */
async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(body);
}

/**
 * Starts the event server. Booting is asynchronous: await `ready` for the bound
 * port, and `done` for full shutdown.
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
    // Graceful stop: stop accepting new connections, then close the listener.
    // The /shutdown route already flushed its response before calling stop, so
    // force-closing any lingering keep-alive sockets is safe and makes the port
    // free up promptly.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    // Drain the queue: process whatever was already enqueued, then exit.
    await queue.stop();
    // End all sessions (finalize + flush their root spans) before we exit.
    await registry.closeAll();
    log.info("server stopped", { port: config.port });
    resolveDone();
  };

  const fallbackHost = `${config.host}:${config.port}`;
  const server = createServer((req, res) => {
    // Buffer the body outside the lock (I/O only), then serialize the actual
    // request handling through requestLock so handlers never interleave with
    // each other or the idle watchdog.
    void (async () => {
      let request: Request;
      try {
        request = await toWebRequest(req, fallbackHost);
      } catch (err) {
        log.error("failed to read request", { error: String(err) });
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad_request" }));
        return;
      }

      const response = await requestLock
        .runExclusive(() =>
          handleRequest(request, {
            state,
            logger: log,
            queue,
            onShutdownRequested: () => {
              void stop();
            },
          }),
        )
        .catch((err) => {
          log.error("request error", { error: String(err) });
          return new Response(JSON.stringify({ error: "internal" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        });

      await writeWebResponse(res, response).catch((err) => {
        log.error("failed to write response", { error: String(err) });
      });
    })();
  });

  let resolveReady!: (port: number) => void;
  const ready = new Promise<number>((resolve) => {
    resolveReady = resolve;
  });
  const running: RunningServer = { port: config.port, ready, state, stop, done };

  // A listen error (e.g. EADDRINUSE) means another server owns the port. Log and
  // shut down so this serve process exits cleanly; the client's ensureServer
  // probes /health and handles a foreign/mismatched server owning the port.
  server.on("error", (err) => {
    log.error("server error", { error: String(err) });
    resolveReady(config.port);
    void stop();
  });

  server.listen(config.port, config.host, () => {
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr !== null ? addr.port : config.port;
    running.port = boundPort;
    resolveReady(boundPort);
    log.info("server started", {
      version: PLUGIN_VERSION,
      host: config.host,
      port: boundPort,
    });
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

  return running;
}
