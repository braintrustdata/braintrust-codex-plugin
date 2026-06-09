// Routes each dequeued event to the EventProcessor for its queueId (session),
// creating one on first use based on the event source. The set of supported
// sources is supplied as a factory map (one per agent), so this registry is
// generic and never names a specific agent. Processors are kept in an LRU map
// capped at MAX_PROCESSORS; the least-recently-used session is evicted when the
// cap is exceeded.

import { defaultSpanFactoryProvider, type SpanFactoryProvider } from "../braintrust/logger.ts";
import type { Logger } from "../log.ts";
import type { EnqueueEvent } from "../server/routes.ts";
import type { EventProcessor, EventProcessorFactory } from "./event-processor.ts";
import { LruMap } from "./lru-map.ts";

/** Max number of concurrent per-session processors retained. */
export const MAX_PROCESSORS = 1024;

/** Key used for events that arrive without a queueId. */
const NO_QUEUE_KEY = "\u0000no-queue-id";

export interface ProcessorRegistryOptions {
  capacity?: number;
  /**
   * Builds the SpanFactory each processor uses. Defaults to a real per-session
   * provider; tests override it to stay offline.
   */
  spanFactoryProvider?: SpanFactoryProvider;
}

export class ProcessorRegistry {
  private readonly processors: LruMap<EventProcessor>;
  private readonly logger: Logger;
  private readonly capacity: number;
  private readonly spanFactoryProvider: SpanFactoryProvider;
  /** Processor factories keyed by event source (one per supported agent). */
  private readonly factories: Map<string, EventProcessorFactory>;

  constructor(
    logger: Logger,
    factories: Map<string, EventProcessorFactory>,
    options: ProcessorRegistryOptions = {},
  ) {
    this.logger = logger;
    this.factories = factories;
    this.capacity = options.capacity ?? MAX_PROCESSORS;
    this.spanFactoryProvider = options.spanFactoryProvider ?? defaultSpanFactoryProvider;
    this.processors = new LruMap<EventProcessor>({
      capacity: this.capacity,
      onEvict: (key, processor) => {
        this.logger.debug("evicted processor", { queueId: key });
        // Flush the victim so its buffered spans are delivered. onEvict is
        // sync, so this is fire-and-forget; errors are logged, never thrown.
        void this.safeFlush(processor, key);
      },
    });
  }

  get size(): number {
    return this.processors.size;
  }

  /** Flush every active processor. Called when the queue goes idle. */
  async flushAll(): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    for (const processor of this.processors.values()) {
      tasks.push(this.safeFlush(processor));
    }
    await Promise.all(tasks);
  }

  /** Flush every active processor and clear the map. Called on server stop. */
  async closeAll(): Promise<void> {
    await this.flushAll();
    this.processors.clear();
  }

  private async safeFlush(processor: EventProcessor, queueId?: string): Promise<void> {
    try {
      await processor.flush();
    } catch (err) {
      this.logger.error("processor flush failed", { queueId, error: String(err) });
    }
  }

  /** Route an event to its session's processor, creating one if needed. */
  async handle(event: EnqueueEvent): Promise<void> {
    if (event.queueId === null) {
      this.logger.warn("event has no queueId (session id)", {
        eventSource: event.eventSource,
        eventName: event.eventName,
      });
    }

    const key = event.queueId ?? NO_QUEUE_KEY;

    let processor = this.processors.get(key);
    if (processor === undefined) {
      const factory = this.factories.get(event.eventSource);
      if (factory === undefined) {
        // Unregistered source: warn and no-op. Don't cache anything.
        this.logger.warn("unrecognized event source; skipping", {
          eventSource: event.eventSource,
          eventName: event.eventName,
          queueId: event.queueId,
        });
        return;
      }
      processor = factory(event.queueId, this.logger, this.spanFactoryProvider);
      this.processors.set(key, processor);
    }

    await processor.process(event);
  }
}
