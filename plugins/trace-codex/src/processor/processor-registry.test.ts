import { describe, expect, test } from "bun:test";
import type { SpanFactory, SpanFactoryProvider } from "../braintrust/logger.ts";
import type { Logger } from "../log.ts";
import type { EnqueueEvent } from "../server/routes.ts";
import { createFakeSpanFactory, createTestLogger } from "../test-helpers.ts";
import type { EventProcessor, EventProcessorFactory } from "./event-processor.ts";
import { ProcessorRegistry } from "./processor-registry.ts";

const TEST_SOURCE = "test-agent";

function event(overrides: Partial<EnqueueEvent> = {}): EnqueueEvent {
  return {
    queueId: "session-1",
    eventSource: TEST_SOURCE,
    eventSourceVersion: null,
    eventName: "SessionStart",
    eventData: {},
    ...overrides,
  };
}

// A minimal processor that opens one span per session and flushes it, so the
// fake span factory's flush/end counters reflect registry behavior.
class TestProcessor implements EventProcessor {
  private readonly span;
  constructor(_queueId: string | null, _logger: Logger, provider: SpanFactoryProvider) {
    this.span = provider().startSpan({ name: "test", type: "task" });
  }
  process(): void {}
  async flush(): Promise<void> {
    await this.span?.flush();
  }
}

const testFactory: EventProcessorFactory = (queueId, logger, provider) =>
  new TestProcessor(queueId, logger, provider);

/** A registry wired with a single test agent factory and a fixed fake factory. */
function makeRegistry(options: { capacity?: number; spanFactory?: SpanFactory } = {}) {
  const { spanFactory, ...rest } = options;
  const provider: SpanFactoryProvider | undefined = spanFactory ? () => spanFactory : undefined;
  return new ProcessorRegistry(createTestLogger(), new Map([[TEST_SOURCE, testFactory]]), {
    ...rest,
    spanFactoryProvider: provider,
  });
}

describe("ProcessorRegistry", () => {
  test("creates a processor for a recognized source and routes the event", async () => {
    const registry = makeRegistry({ spanFactory: createFakeSpanFactory() });
    await registry.handle(event());
    expect(registry.size).toBe(1);
  });

  test("reuses the same processor for the same queueId", async () => {
    const registry = makeRegistry({ spanFactory: createFakeSpanFactory() });
    await registry.handle(event({ queueId: "s1", eventName: "SessionStart" }));
    await registry.handle(event({ queueId: "s1", eventName: "Stop" }));
    expect(registry.size).toBe(1);
  });

  test("creates separate processors for different queueIds", async () => {
    const registry = makeRegistry({ spanFactory: createFakeSpanFactory() });
    await registry.handle(event({ queueId: "s1" }));
    await registry.handle(event({ queueId: "s2" }));
    expect(registry.size).toBe(2);
  });

  test("no-ops on an unrecognized source without caching", async () => {
    const registry = makeRegistry({ spanFactory: createFakeSpanFactory() });
    await registry.handle(event({ eventSource: "mystery-source" }));
    expect(registry.size).toBe(0);
  });

  test("processes an event with no queueId", async () => {
    const registry = makeRegistry({ spanFactory: createFakeSpanFactory() });
    await registry.handle(event({ queueId: null }));
    expect(registry.size).toBe(1);
  });

  test("evicts and flushes the least-recently-used processor at capacity", async () => {
    const factory = createFakeSpanFactory();
    const registry = makeRegistry({ capacity: 2, spanFactory: factory });
    await registry.handle(event({ queueId: "s1" }));
    await registry.handle(event({ queueId: "s2" }));
    await registry.handle(event({ queueId: "s3" })); // evicts s1
    expect(registry.size).toBe(2);
    // The evicted processor's span (s1, the first created) was flushed, not ended.
    // Allow the fire-and-forget eviction flush to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(factory.spans[0].flushCount).toBeGreaterThanOrEqual(1);
    expect(factory.spans[0].endCount).toBe(0);
  });

  test("flushAll flushes every active processor", async () => {
    const factory = createFakeSpanFactory();
    const registry = makeRegistry({ spanFactory: factory });
    await registry.handle(event({ queueId: "s1" }));
    await registry.handle(event({ queueId: "s2" }));
    await registry.flushAll();
    expect(factory.spans.length).toBe(2);
    expect(factory.spans.every((s) => s.flushCount >= 1)).toBe(true);
  });

  test("closeAll flushes every processor (without ending spans) and clears", async () => {
    const factory = createFakeSpanFactory();
    const registry = makeRegistry({ spanFactory: factory });
    await registry.handle(event({ queueId: "s1" }));
    await registry.handle(event({ queueId: "s2" }));
    await registry.closeAll();
    expect(factory.spans.every((s) => s.flushCount >= 1)).toBe(true);
    expect(factory.spans.every((s) => s.endCount === 0)).toBe(true);
    expect(registry.size).toBe(0);
  });
});
