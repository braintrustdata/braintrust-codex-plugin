import { describe, expect, test, vi } from "vitest";
import type { Config } from "../config.ts";
import { createTestLogger } from "../test-helpers.ts";
import { type EnsureServerDeps, ensureServer, type HealthStatus } from "./ensure-server.ts";

const config: Config = {
  host: "127.0.0.1",
  port: 52799,
  idleTimeoutMs: 1000,
  idleCheckIntervalMs: 100,
  dataDir: "/tmp/test",
};

const fastTimings = {
  bootHealthAttempts: 5,
  bootHealthIntervalMs: 0,
  shutdownWaitAttempts: 5,
  shutdownWaitIntervalMs: 0,
};

/** Build deps where checkHealth returns a scripted sequence of statuses. */
function makeDeps(statuses: HealthStatus[]): {
  deps: EnsureServerDeps;
  spawn: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const checkHealth = vi.fn(async (): Promise<HealthStatus> => {
    const s = statuses[Math.min(i, statuses.length - 1)];
    i++;
    return s;
  });
  const spawn = vi.fn(() => {});
  return {
    spawn,
    deps: {
      config,
      logger: createTestLogger(),
      checkHealth,
      spawn,
      sleep: async () => {},
      timings: fastTimings,
    },
  };
}

describe("ensureServer", () => {
  test("reuses an already-healthy server without spawning", async () => {
    const { deps, spawn } = makeDeps(["healthy"]);
    const ok = await ensureServer(deps);
    expect(ok).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  test("boots a server when none is reachable", async () => {
    // unreachable first, then healthy after boot
    const { deps, spawn } = makeDeps(["unreachable", "healthy"]);
    const ok = await ensureServer(deps);
    expect(ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("waits for a shutting-down server, then boots", async () => {
    // shutting_down -> unreachable (it stopped) -> healthy (ours booted)
    const { deps, spawn } = makeDeps(["shutting_down", "unreachable", "healthy"]);
    const ok = await ensureServer(deps);
    expect(ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("reuses the winner if a healthy server appears during shutdown wait", async () => {
    // shutting_down -> healthy (someone else booted): we end up healthy.
    const { deps } = makeDeps(["shutting_down", "healthy"]);
    const ok = await ensureServer(deps);
    expect(ok).toBe(true);
  });

  test("returns false when the server never becomes healthy", async () => {
    const { deps } = makeDeps(["unreachable"]);
    const ok = await ensureServer(deps);
    expect(ok).toBe(false);
  });

  test("bails immediately on a version mismatch without spawning", async () => {
    const { deps, spawn } = makeDeps(["version_mismatch"]);
    const ok = await ensureServer(deps);
    expect(ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  test("bails if a mismatched server wins the port race after boot", async () => {
    // unreachable -> (boot) -> version_mismatch: bail rather than poll forever.
    const { deps, spawn } = makeDeps(["unreachable", "version_mismatch"]);
    const ok = await ensureServer(deps);
    expect(ok).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("checkHealth version gating", () => {
  test("treats a matching version as healthy and a mismatch as version_mismatch", async () => {
    const { PLUGIN_VERSION } = await import("../version.ts");
    const { checkHealth } = await import("./ensure-server.ts");

    const originalFetch = globalThis.fetch;
    const fakeFetch = (version: string) =>
      (async () =>
        new Response(JSON.stringify({ version }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
    try {
      globalThis.fetch = fakeFetch(PLUGIN_VERSION);
      expect(await checkHealth(config)).toBe("healthy");

      globalThis.fetch = fakeFetch("9.9.9-different");
      expect(await checkHealth(config)).toBe("version_mismatch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
