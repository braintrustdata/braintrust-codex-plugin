// Public surface of the Codex agent module. index.ts imports `codexAgent` and
// wires it into the generic core (processor registry, hook client). Adding
// another agent means adding a sibling module that exports the same shape.

import type { EventBuilder } from "../../client/client.ts";
import type { Logger } from "../../log.ts";
import type { EventProcessorFactory } from "../../processor/event-processor.ts";
import { buildEnqueueEvents, CODEX_EVENT_SOURCE } from "./event-builder.ts";
import { CodexEventProcessor } from "./event-processor.ts";
import { applySettingsToEnv, loadSettingsFile, settingsFilePath } from "./settings.ts";
import { SnapshotStore } from "./snapshot-store.ts";

export interface Agent {
  /** Event source string this agent's events carry (matches the registry key). */
  eventSource: string;
  /** Creates a per-session processor for this agent's events. */
  createProcessor: EventProcessorFactory;
  /** Translates the agent's raw stdin payload into one or more EnqueueEvents. */
  buildEvents: EventBuilder;
  /**
   * Event names that terminate a turn/session. After enqueuing one of these,
   * the hook asks the server to flush. By default the flush is fire-and-forget
   * so the turn isn't stalled; setting BRAINTRUST_FLUSH_ON_TURN_END makes the
   * hook block until the server confirms the final spans are delivered before
   * the process tree is torn down (e.g. in CI). Codex only exposes a per-turn
   * "Stop" hook today; there is no session-end event.
   */
  terminalEvents: string[];
  /**
   * Read this agent's user settings and apply them to the environment
   * (environment wins). Returns the names of applied settings, for diagnostics
   * (never values). Run before booting the server so the client and server
   * agree on configuration.
   */
  loadSettings: () => string[];
}

// One shared snapshot store for all Codex sessions, created on first use. It
// persists each session's resumable state under PLUGIN_DATA/state so a restarted
// server can rehydrate in-progress traces. Created lazily (reusing the first
// session's logger) so a one-time GC of stale orphan snapshots runs the first
// time we actually trace, and so this module stays side-effect-free on import.
let sharedSnapshotStore: SnapshotStore | null = null;
function snapshotStore(logger: Logger): SnapshotStore {
  if (sharedSnapshotStore === null) {
    sharedSnapshotStore = new SnapshotStore(logger);
    // Reclaim stale snapshots. Snapshots intentionally outlive their root span
    // (later turns resume onto the same root), so they are never self-deleted on
    // root-end; the only cleanup is this age-based sweep of ones that never
    // resumed.
    sharedSnapshotStore.gcOlderThan();
  }
  return sharedSnapshotStore;
}

export const codexAgent: Agent = {
  eventSource: CODEX_EVENT_SOURCE,
  createProcessor: (queueId, logger, spanFactoryProvider) =>
    new CodexEventProcessor(queueId, logger, spanFactoryProvider, undefined, snapshotStore(logger)),
  buildEvents: buildEnqueueEvents,
  terminalEvents: ["Stop"],
  loadSettings: () => applySettingsToEnv(loadSettingsFile(settingsFilePath())),
};
