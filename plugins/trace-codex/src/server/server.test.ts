import { describe, expect, test } from "bun:test";
import type { Config } from "../config.ts";
import type { EventProcessorFactory } from "../processor/event-processor.ts";
import { createTestLogger } from "../test-helpers.ts";
import { PLUGIN_VERSION } from "../version.ts";
import { startServer } from "./server.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    // Port 0 lets the OS pick a free port, avoiding collisions between tests.
    port: 0,
    idleTimeoutMs: 60_000,
    idleCheckIntervalMs: 60_000,
    dataDir: "/tmp/braintrust-event-server-test",
    ...overrides,
  };
}

describe("startServer", () => {
  test("serves /health and stops via stop()", async () => {
    const server = startServer(testConfig(), new Map(), createTestLogger());
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ version: PLUGIN_VERSION });
    } finally {
      await server.stop();
    }
    await server.done; // resolves once fully stopped
  });

  test("idle watchdog shuts the server down after inactivity", async () => {
    const server = startServer(
      testConfig({ idleTimeoutMs: 10, idleCheckIntervalMs: 10 }),
      new Map(),
      createTestLogger(),
    );

    // Wait for the watchdog to fire and stop the server.
    const stoppedInTime = await Promise.race([
      server.done.then(() => true),
      sleep(2000).then(() => false),
    ]);

    expect(stoppedInTime).toBe(true);

    // The port should no longer accept connections.
    let refused = false;
    try {
      await fetch(`http://127.0.0.1:${server.port}/health`, {
        signal: AbortSignal.timeout(500),
      });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  test("activity resets the idle timer", async () => {
    const server = startServer(
      testConfig({ idleTimeoutMs: 120, idleCheckIntervalMs: 20 }),
      new Map(),
      createTestLogger(),
    );

    try {
      // Keep it alive past the idle window by pinging /health repeatedly.
      for (let i = 0; i < 6; i++) {
        await sleep(40);
        const res = await fetch(`http://127.0.0.1:${server.port}/health`);
        expect(res.status).toBe(200);
      }
      // ~240ms elapsed (> idleTimeoutMs) but activity kept it up.
      expect(server.state.isShuttingDown()).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test("draining the queue counts as activity and keeps the server alive", async () => {
    let processed = 0;
    // Each event takes a little time; the whole backlog outlasts the idle
    // window, but no single event does. Pulling each event off the queue bumps
    // the heartbeat, so the watchdog never sees the server as idle mid-drain.
    const factory: EventProcessorFactory = () => ({
      process: async () => {
        await sleep(40);
        processed++;
      },
      flush: () => {},
    });

    const server = startServer(
      testConfig({ idleTimeoutMs: 60, idleCheckIntervalMs: 20 }),
      new Map([["test", factory]]),
      createTestLogger(),
    );

    try {
      // Enqueue a backlog whose total processing time (~240ms) far exceeds the
      // 60ms idle window.
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`http://127.0.0.1:${server.port}/enqueue`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            queueId: "s1",
            eventSource: "test",
            eventSourceVersion: null,
            eventName: "UserPromptSubmit",
            eventData: {},
          }),
        });
        expect(res.status).toBe(200);
      }

      // Wait for the whole backlog to drain.
      while (processed < 6) await sleep(20);

      // The server stayed up the entire time despite each idle check seeing no
      // HTTP traffic, because draining bumped the heartbeat.
      expect(server.state.isShuttingDown()).toBe(false);
    } finally {
      await server.stop();
    }
  });
});
