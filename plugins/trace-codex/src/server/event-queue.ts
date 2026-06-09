// An in-memory FIFO queue of events with a single background consumer.
//
// /enqueue pushes onto the queue and returns immediately. A consumer loop pops
// events one at a time and processes them (currently: logs them). Processing is
// serialized: one event is handled to completion before the next is popped, so
// a processor can safely do async work without interleaving.

import type { Logger } from "../log.ts";
import type { EnqueueEvent } from "./routes.ts";

/** Handles a single dequeued event. */
export type EventHandler = (event: EnqueueEvent) => Promise<void> | void;

/** Called once each time the queue drains to empty (before parking). */
export type IdleHandler = () => Promise<void> | void;

export interface EventQueueOptions {
  logger: Logger;
  /** Handles each dequeued event. Defaults to a logging no-op. */
  handler?: EventHandler;
  /** Invoked when the queue drains to empty (e.g. to flush buffered state). */
  onIdle?: IdleHandler;
}

export class EventQueue {
  private readonly items: EnqueueEvent[] = [];
  private readonly logger: Logger;
  private readonly handler: EventHandler;
  private readonly onIdle?: IdleHandler;

  // Resolver for a consumer that is parked waiting for the next item.
  private waiter: (() => void) | null = null;
  private draining = false;
  private consuming = false;
  // Resolves once the consumer loop has fully exited after stop().
  private stopped: Promise<void> | null = null;
  // Resolvers waiting for the queue to next reach empty (see drained()).
  private drainWaiters: Array<() => void> = [];

  constructor(options: EventQueueOptions) {
    this.logger = options.logger;
    this.handler = options.handler ?? ((event) => this.logEvent(event));
    this.onIdle = options.onIdle;
  }

  /** Number of events currently waiting to be processed. */
  get size(): number {
    return this.items.length;
  }

  /**
   * Resolves the next time the queue drains to empty (i.e. all items enqueued
   * up to now have been processed). If the queue is already empty and nothing
   * is being processed, resolves on the next consumer pass. Used by /flush to
   * wait for in-flight events before flushing processors.
   */
  drained(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
      // Nudge the consumer in case it's parked, so an empty queue still makes a
      // pass and resolves the waiter promptly.
      if (this.waiter) {
        const wake = this.waiter;
        this.waiter = null;
        wake();
      }
    });
  }

  private notifyDrained(): void {
    if (this.drainWaiters.length === 0) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Push an event onto the queue. Non-blocking. */
  enqueue(event: EnqueueEvent): void {
    if (this.draining) {
      // Dropping is fine: once draining, the server is shutting down.
      this.logger.warn("enqueue after drain; dropping event", {
        queueId: event.queueId,
        eventName: event.eventName,
      });
      return;
    }
    this.items.push(event);
    // Wake a parked consumer, if any.
    if (this.waiter) {
      const wake = this.waiter;
      this.waiter = null;
      wake();
    }
  }

  /** Start the background consumer loop. Idempotent. */
  start(): void {
    if (this.consuming) return;
    this.consuming = true;
    this.stopped = this.consumeLoop();
  }

  /**
   * Stop accepting new events, let the consumer finish what's already queued,
   * and wait for the loop to exit.
   */
  async stop(): Promise<void> {
    this.draining = true;
    // Wake the consumer so it can observe the drain state and exit when empty.
    if (this.waiter) {
      const wake = this.waiter;
      this.waiter = null;
      wake();
    }
    await this.stopped;
  }

  private async consumeLoop(): Promise<void> {
    while (true) {
      const event = this.items.shift();
      if (event === undefined) {
        if (this.draining) {
          // Drained and stopping: release any drain waiters before exiting so
          // they don't hang.
          this.notifyDrained();
          return;
        }
        // The queue just went empty: run the idle handler (e.g. flush) once,
        // then re-check — items may have arrived while it ran.
        await this.runIdle();
        if (this.items.length > 0) continue;
        // The queue is empty and processors have been flushed: any /flush
        // waiters can now observe their events as fully delivered.
        this.notifyDrained();
        if (this.draining) return;
        // Park until something is enqueued (or we're woken to drain).
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
        continue;
      }
      try {
        await this.handler(event);
      } catch (err) {
        this.logger.error("event processing failed", {
          queueId: event.queueId,
          eventName: event.eventName,
          error: String(err),
        });
      }
    }
  }

  private async runIdle(): Promise<void> {
    if (!this.onIdle) return;
    try {
      await this.onIdle();
    } catch (err) {
      this.logger.error("idle handler failed", { error: String(err) });
    }
  }

  private logEvent(event: EnqueueEvent): void {
    if (event.queueId === null) {
      this.logger.warn("event has no queueId (session id)", {
        eventSource: event.eventSource,
        eventName: event.eventName,
      });
    }
    // Placeholder: just log the dequeued event.
    this.logger.info("process event", {
      queueId: event.queueId,
      eventSource: event.eventSource,
      eventSourceVersion: event.eventSourceVersion,
      eventName: event.eventName,
      eventData: event.eventData,
    });
  }
}
