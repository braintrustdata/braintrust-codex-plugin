import { describe, expect, test } from "bun:test";
import { createTestLogger } from "../test-helpers.ts";
import { EventQueue } from "./event-queue.ts";
import type { EnqueueEvent } from "./routes.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEvent(overrides: Partial<EnqueueEvent> = {}): EnqueueEvent {
  return {
    queueId: "session-1",
    eventSource: "codex-hook",
    eventSourceVersion: null,
    eventName: "SessionStart",
    eventData: {},
    ...overrides,
  };
}

describe("EventQueue", () => {
  test("processes enqueued events via the consumer", async () => {
    const processed: EnqueueEvent[] = [];
    const queue = new EventQueue({
      logger: createTestLogger(),
      handler: (e) => {
        processed.push(e);
      },
    });
    queue.start();

    queue.enqueue(makeEvent({ eventName: "SessionStart" }));
    queue.enqueue(makeEvent({ eventName: "Stop" }));

    await queue.stop();

    expect(processed.map((e) => e.eventName)).toEqual(["SessionStart", "Stop"]);
  });

  test("processes events in FIFO order, one at a time", async () => {
    const order: string[] = [];
    const queue = new EventQueue({
      logger: createTestLogger(),
      handler: async (e) => {
        order.push(`${e.eventName}:start`);
        await sleep(5);
        order.push(`${e.eventName}:end`);
      },
    });
    queue.start();

    queue.enqueue(makeEvent({ eventName: "a" }));
    queue.enqueue(makeEvent({ eventName: "b" }));
    queue.enqueue(makeEvent({ eventName: "c" }));

    await queue.stop();

    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  test("enqueue is non-blocking; size reflects pending items", () => {
    const queue = new EventQueue({ logger: createTestLogger() });
    // Not started: items just accumulate.
    queue.enqueue(makeEvent());
    queue.enqueue(makeEvent());
    expect(queue.size).toBe(2);
  });

  test("a failing processor does not stop the consumer", async () => {
    const processed: string[] = [];
    let first = true;
    const queue = new EventQueue({
      logger: createTestLogger(),
      handler: (e) => {
        if (first) {
          first = false;
          throw new Error("boom");
        }
        processed.push(e.eventName);
      },
    });
    queue.start();

    queue.enqueue(makeEvent({ eventName: "bad" }));
    queue.enqueue(makeEvent({ eventName: "good" }));

    await queue.stop();

    // The good event is still processed after the bad one throws.
    expect(processed).toEqual(["good"]);
  });

  test("drains remaining events on stop", async () => {
    const processed: string[] = [];
    const queue = new EventQueue({
      logger: createTestLogger(),
      handler: async (e) => {
        await sleep(2);
        processed.push(e.eventName);
      },
    });
    queue.start();

    queue.enqueue(makeEvent({ eventName: "x" }));
    queue.enqueue(makeEvent({ eventName: "y" }));
    // stop() should wait for both to finish.
    await queue.stop();

    expect(processed).toEqual(["x", "y"]);
  });

  test("drops events enqueued after stop", async () => {
    const processed: string[] = [];
    const queue = new EventQueue({
      logger: createTestLogger(),
      handler: (e) => {
        processed.push(e.eventName);
      },
    });
    queue.start();
    await queue.stop();

    queue.enqueue(makeEvent({ eventName: "late" }));
    expect(queue.size).toBe(0);
    expect(processed).toEqual([]);
  });

  test("fires onIdle when the queue drains to empty", async () => {
    let idleCount = 0;
    const queue = new EventQueue({
      logger: createTestLogger(),
      handler: () => {},
      onIdle: () => {
        idleCount += 1;
      },
    });
    queue.start();
    queue.enqueue(makeEvent());
    queue.enqueue(makeEvent());

    // Wait for the queue to process both and go idle.
    await sleep(20);
    expect(idleCount).toBeGreaterThanOrEqual(1);
    await queue.stop();
  });

  test("drained() resolves after pending events are processed", async () => {
    const processed: string[] = [];
    const queue = new EventQueue({
      logger: createTestLogger(),
      handler: async (e) => {
        await sleep(10);
        processed.push(e.eventName);
      },
    });
    queue.start();
    queue.enqueue(makeEvent({ eventName: "a" }));
    queue.enqueue(makeEvent({ eventName: "b" }));

    await queue.drained();
    // Everything enqueued before drained() must be processed by the time it
    // resolves.
    expect(processed).toEqual(["a", "b"]);

    await queue.stop();
  });

  test("drained() resolves promptly when the queue is already empty", async () => {
    const queue = new EventQueue({ logger: createTestLogger(), handler: () => {} });
    queue.start();
    // Nothing enqueued: the next idle pass should resolve the waiter.
    await queue.drained();
    await queue.stop();
  });

  test("drained() resolves (does not hang) if the queue is stopping", async () => {
    const queue = new EventQueue({ logger: createTestLogger(), handler: () => {} });
    queue.start();
    const drained = queue.drained();
    await queue.stop();
    // Must not hang even though stop() set draining before the waiter resolved.
    await drained;
  });

  test("processes events that arrive during the onIdle handler", async () => {
    const processed: string[] = [];
    let firstIdle = true;
    const queue = new EventQueue({
      logger: createTestLogger(),
      handler: (e) => {
        processed.push(e.eventName);
      },
      onIdle: async () => {
        // On the first idle, enqueue one more; it must still get processed.
        if (firstIdle) {
          firstIdle = false;
          queue.enqueue(makeEvent({ eventName: "late-from-idle" }));
        }
      },
    });
    queue.start();
    queue.enqueue(makeEvent({ eventName: "first" }));

    await sleep(20);
    expect(processed).toContain("first");
    expect(processed).toContain("late-from-idle");
    await queue.stop();
  });
});
