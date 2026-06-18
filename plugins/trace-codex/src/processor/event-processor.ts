// EventProcessor is the interface implemented per event source (Codex today;
// Claude Code, opencode, etc. later). One processor instance is created per
// queueId (session) and receives that session's events in order.
//
// Each agent module provides an EventProcessorFactory and registers it (keyed by
// its eventSource) with the ProcessorRegistry. The registry itself is generic
// and never names a specific agent.

import type { SpanFactoryProvider } from "../braintrust/logger.ts";
import type { Logger } from "../log.ts";
import type { EnqueueEvent } from "../server/routes.ts";

export interface EventProcessor {
  /** Handle a single event for this session. */
  process(event: EnqueueEvent): Promise<void> | void;

  /**
   * Flush any buffered state to its backend. Called when the queue goes idle,
   * on eviction, and on server stop. Must not throw and must not mutate span
   * data (e.g. it must not end spans) — flushing only delivers what already
   * exists.
   */
  flush(): Promise<void> | void;
}

/**
 * Creates a per-session EventProcessor for one event source. Receives a
 * SpanFactoryProvider (not a concrete factory) so the processor can build its
 * own logger from per-session config.
 */
export type EventProcessorFactory = (
  queueId: string | null,
  logger: Logger,
  spanFactoryProvider: SpanFactoryProvider,
) => EventProcessor;
