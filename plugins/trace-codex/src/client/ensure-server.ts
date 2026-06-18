// Ensure a healthy event server is running, booting one if needed.
//
// State machine:
//   - /health refused           -> boot our own, wait until healthy
//   - /health 200 (healthy)     -> reuse it
//   - /health 503 (shutting)    -> wait until it stops, then boot our own
//   - /health version mismatch  -> bail (a different server version owns the
//                                  port; do not enqueue)
//   - boot loses a port race    -> re-check /health; reuse the winner
//   - still unhealthy at end    -> return false (caller logs + exits 0)

import type { Config } from "../config.ts";
import { serverBaseUrl } from "../config.ts";
import type { Logger } from "../log.ts";
import { PLUGIN_VERSION } from "../version.ts";

export type HealthStatus = "healthy" | "shutting_down" | "version_mismatch" | "unreachable";

export interface EnsureServerDeps {
  config: Config;
  logger: Logger;
  /** Probe /health. */
  checkHealth: (config: Config) => Promise<HealthStatus>;
  /** Boot a detached server. */
  spawn: (config: Config, logger: Logger) => void;
  /** Sleep helper (injectable for tests). */
  sleep: (ms: number) => Promise<void>;
  /** Tunables (injectable for tests). */
  timings?: Partial<EnsureTimings>;
}

export interface EnsureTimings {
  /** Max attempts to reach health after booting. */
  bootHealthAttempts: number;
  /** Delay between post-boot health probes. */
  bootHealthIntervalMs: number;
  /** Max attempts to wait for a shutting-down server to disappear. */
  shutdownWaitAttempts: number;
  /** Delay between shutdown-wait probes. */
  shutdownWaitIntervalMs: number;
}

const DEFAULT_TIMINGS: EnsureTimings = {
  bootHealthAttempts: 50,
  bootHealthIntervalMs: 100,
  shutdownWaitAttempts: 100,
  shutdownWaitIntervalMs: 100,
};

/** Default health probe using fetch with a short timeout. */
export async function checkHealth(config: Config): Promise<HealthStatus> {
  try {
    const res = await fetch(`${serverBaseUrl(config)}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(1000),
    });
    if (res.status === 503) return "shutting_down";
    if (!res.ok) return "unreachable";

    // A healthy server must match our version. If a different version owns the
    // port, treat it as a mismatch so the caller bails.
    try {
      const body = (await res.json()) as { version?: unknown };
      if (body.version !== PLUGIN_VERSION) return "version_mismatch";
    } catch {
      return "version_mismatch";
    }
    return "healthy";
  } catch {
    return "unreachable";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns true if a healthy server is available to receive events. */
export async function ensureServer(deps: EnsureServerDeps): Promise<boolean> {
  const { config, logger, checkHealth, spawn } = deps;
  const timings = { ...DEFAULT_TIMINGS, ...deps.timings };

  const status = await checkHealth(config);

  if (status === "healthy") {
    return true;
  }

  if (status === "version_mismatch") {
    // A different server version owns the port. Bail without enqueuing rather
    // than fighting over the port or sending events to an incompatible server.
    logger.warn("event server version mismatch; skipping", {
      clientVersion: PLUGIN_VERSION,
    });
    return false;
  }

  if (status === "shutting_down") {
    logger.info("server is shutting down; waiting for it to stop");
    const stopped = await waitForStop(deps, timings);
    if (!stopped) {
      logger.error("timed out waiting for shutting-down server");
      return false;
    }
    // Fall through to boot our own.
  }

  // status === "unreachable" (or just-stopped): boot our own.
  spawn(config, logger);
  return waitForHealthy(deps, timings);
}

async function waitForStop(deps: EnsureServerDeps, timings: EnsureTimings): Promise<boolean> {
  for (let i = 0; i < timings.shutdownWaitAttempts; i++) {
    const status = await deps.checkHealth(deps.config);
    if (status === "unreachable") return true;
    // If it came back healthy (e.g. a new server booted), reuse it.
    if (status === "healthy") return true;
    await deps.sleep(timings.shutdownWaitIntervalMs);
  }
  return false;
}

async function waitForHealthy(deps: EnsureServerDeps, timings: EnsureTimings): Promise<boolean> {
  for (let i = 0; i < timings.bootHealthAttempts; i++) {
    const status = await deps.checkHealth(deps.config);
    if (status === "healthy") return true;
    // A different version won the port race: bail instead of polling forever.
    if (status === "version_mismatch") {
      deps.logger.warn("event server version mismatch after boot; skipping", {
        clientVersion: PLUGIN_VERSION,
      });
      return false;
    }
    // A "shutting_down" here means someone else's server is going away; keep
    // polling — either it dies (then ours never bound, re-handled by caller) or
    // a fresh one comes up healthy.
    await deps.sleep(timings.bootHealthIntervalMs);
  }
  return false;
}
