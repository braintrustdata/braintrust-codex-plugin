// Public surface of the Codex agent module. index.ts imports `codexAgent` and
// wires it into the generic core (processor registry, hook client). Adding
// another agent means adding a sibling module that exports the same shape.

import type { EventBuilder } from "../../client/client.ts";
import type { EventProcessorFactory } from "../../processor/event-processor.ts";
import { buildEnqueueEvents, CODEX_EVENT_SOURCE } from "./event-builder.ts";
import { CodexEventProcessor } from "./event-processor.ts";
import { applySettingsToEnv, loadSettingsFile, settingsFilePath } from "./settings.ts";

export interface Agent {
  /** Event source string this agent's events carry (matches the registry key). */
  eventSource: string;
  /** Creates a per-session processor for this agent's events. */
  createProcessor: EventProcessorFactory;
  /** Translates the agent's raw stdin payload into one or more EnqueueEvents. */
  buildEvents: EventBuilder;
  /**
   * Event names that terminate a turn/session. After enqueuing one of these,
   * the hook asks the server to flush synchronously so the final spans are
   * delivered before the process tree is torn down (e.g. in CI). Codex only
   * exposes a per-turn "Stop" hook today; there is no session-end event.
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

export const codexAgent: Agent = {
  eventSource: CODEX_EVENT_SOURCE,
  createProcessor: (queueId, logger, spanFactoryProvider) =>
    new CodexEventProcessor(queueId, logger, spanFactoryProvider),
  buildEvents: buildEnqueueEvents,
  terminalEvents: ["Stop"],
  loadSettings: () => applySettingsToEnv(loadSettingsFile(settingsFilePath())),
};
