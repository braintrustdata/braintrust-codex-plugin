import { describe, expect, test } from "vitest";
import { createTestLogger } from "../test-helpers.ts";
import { EventQueue } from "./event-queue.ts";
import { handleRequest, type RouteDeps } from "./routes.ts";
import { ServerState } from "./state.ts";

// A sentinel version so the /health test proves it echoes the state's version
// rather than any hardcoded constant.
const TEST_VERSION = "test-1.2.3";

function makeDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  const logger = createTestLogger();
  return {
    state: new ServerState(TEST_VERSION),
    logger,
    queue: new EventQueue({ logger }),
    onShutdownRequested: () => {},
    ...overrides,
  };
}

function get(path: string): Request {
  return new Request(`http://127.0.0.1/${path.replace(/^\//, "")}`, { method: "GET" });
}

function post(path: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1/${path.replace(/^\//, "")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("GET /health", () => {
  test("echoes the server's version", async () => {
    const res = await handleRequest(get("/health"), makeDeps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: TEST_VERSION });
  });

  test("returns 503 when shutting down", async () => {
    const state = new ServerState(TEST_VERSION);
    state.beginShutdown();
    const res = await handleRequest(get("/health"), makeDeps({ state }));
    expect(res.status).toBe(503);
  });
});

describe("POST /enqueue", () => {
  const validEvent = {
    queueId: "session-abc",
    eventSource: "codex-hook",
    eventSourceVersion: null,
    eventName: "UserPromptSubmit",
    eventData: { hook_event_name: "UserPromptSubmit" },
  };

  test("accepts a valid event and pushes it onto the queue", async () => {
    const deps = makeDeps();
    const res = await handleRequest(post("/enqueue", validEvent), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deps.queue.size).toBe(1);
  });

  test("accepts an event with a null queueId", async () => {
    const deps = makeDeps();
    const res = await handleRequest(post("/enqueue", { ...validEvent, queueId: null }), deps);
    expect(res.status).toBe(200);
    expect(deps.queue.size).toBe(1);
  });

  test("rejects invalid JSON", async () => {
    const req = new Request("http://127.0.0.1/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await handleRequest(req, makeDeps());
    expect(res.status).toBe(400);
  });

  test("rejects wrong shape", async () => {
    const res = await handleRequest(post("/enqueue", { foo: "bar" }), makeDeps());
    expect(res.status).toBe(400);
  });

  test("returns 503 when shutting down", async () => {
    const state = new ServerState(TEST_VERSION);
    state.beginShutdown();
    const res = await handleRequest(post("/enqueue", validEvent), makeDeps({ state }));
    expect(res.status).toBe(503);
  });
});

describe("POST /shutdown", () => {
  test("returns 200 empty body and triggers shutdown callback", async () => {
    let shutdownCalled = false;
    const state = new ServerState(TEST_VERSION);
    const res = await handleRequest(
      post("/shutdown"),
      makeDeps({ state, onShutdownRequested: () => (shutdownCalled = true) }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(state.isShuttingDown()).toBe(true);
    // callback is deferred via setTimeout; wait a tick.
    await new Promise((r) => setTimeout(r, 80));
    expect(shutdownCalled).toBe(true);
  });
});

describe("POST /flush", () => {
  const validEvent = {
    queueId: "session-abc",
    eventSource: "codex-hook",
    eventSourceVersion: null,
    eventName: "Stop",
    eventData: { hook_event_name: "Stop" },
  };

  test("waits for the queue to drain, then returns ok", async () => {
    const processed: string[] = [];
    const logger = createTestLogger();
    const queue = new EventQueue({
      logger,
      handler: async (e) => {
        await new Promise((r) => setTimeout(r, 10));
        processed.push(e.eventName);
      },
    });
    queue.start();
    const deps = makeDeps({ logger, queue });

    // Enqueue a Stop, then flush. The flush response must come only after the
    // event has been processed.
    await handleRequest(post("/enqueue", validEvent), deps);
    const res = await handleRequest(post("/flush"), deps);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(processed).toEqual(["Stop"]);

    await queue.stop();
  });
});

describe("unknown routes", () => {
  test("404", async () => {
    const res = await handleRequest(get("/nope"), makeDeps());
    expect(res.status).toBe(404);
  });
});

describe("heartbeat", () => {
  test("any request bumps the heartbeat", async () => {
    const state = new ServerState(TEST_VERSION, 1000);
    expect(state.getLastHeartbeat()).toBe(1000);
    // handleRequest calls state.bump() with Date.now(); just assert it changed.
    await handleRequest(get("/health"), makeDeps({ state }));
    expect(state.getLastHeartbeat()).toBeGreaterThan(1000);
  });
});
