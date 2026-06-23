// Entry point. One binary, three modes:
//   codex-hook serve          -> run the long-lived background event server
//   codex-hook replay <file>  -> re-POST a recorded NDJSON session to the server
//   codex-hook hook           -> (default) read a hook event from stdin, enqueue it
//
// The hook mode never fails the Codex turn: it always exits 0.

import { codexAgent } from "./agents/codex/register.ts";
import { runHookClient } from "./client/client.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import type { EventProcessorFactory } from "./processor/event-processor.ts";
import { runReplay } from "./replay/replay.ts";
import { startServer } from "./server/server.ts";

// The set of agents this plugin supports. Adding another agent (e.g. Claude
// Code) is a one-line change here plus a new src/agents/<agent>/ module.
const AGENTS = [codexAgent];

/** Processor factories keyed by event source, for the server's registry. */
function agentFactories(): Map<string, EventProcessorFactory> {
  return new Map(AGENTS.map((a) => [a.eventSource, a.createProcessor]));
}

/** Parse a boolean env var: true only for "true"/"1" (case-insensitive). */
function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1";
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "hook";

  if (mode === "serve") {
    const config = loadConfig();
    const logger = createLogger({ dataDir: config.dataDir, component: "server" });
    const server = startServer(config, agentFactories(), logger);
    // Stay alive until the server stops (idle, /shutdown, or signal).
    process.on("SIGTERM", () => void server.stop());
    process.on("SIGINT", () => void server.stop());
    await server.done;
    return;
  }

  if (mode === "replay") {
    const config = loadConfig();
    const logger = createLogger({ dataDir: config.dataDir, component: "replay" });
    const filePath = process.argv[3];
    if (!filePath) {
      logger.error("replay: missing file argument; usage: codex-hook replay <file>");
      return;
    }
    await runReplay(config, logger, filePath);
    return;
  }

  // Default: hook client. The hook is the client-side entry point, so this is
  // where the agent reads its user settings and maps them onto the environment
  // (environment wins). We do this BEFORE loadConfig so the client and the
  // server it may spawn agree on port/etc. The spawned server inherits this
  // resolved env. Swallow everything; never break the agent's turn.
  const agent = codexAgent;
  const dataDir = loadConfig().dataDir; // resolve data dir to locate the settings file
  const applied = agent.loadSettings();
  const config = loadConfig(); // re-resolve now that settings are in the env
  const logger = createLogger({ dataDir, component: "hook" });
  if (applied.length > 0) {
    logger.info("applied settings from config", { settings: applied });
  }
  try {
    await runHookClient(config, logger, agent.buildEvents, {
      terminalEvents: agent.terminalEvents,
      // Settings (above) have mapped BRAINTRUST_FLUSH_ON_TURN_END into env.
      flushOnTurnEnd: parseBoolEnv(process.env.BRAINTRUST_FLUSH_ON_TURN_END),
    });
  } catch (err) {
    logger.error("unexpected hook client error", { error: String(err) });
  }
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
