// Spawn the background server by re-executing this binary with "serve".
//
// In a Bun-compiled standalone binary, process.execPath is the binary itself,
// so re-exec'ing it with "serve" runs the server entrypoint. We detach and
// unref the child so it outlives this short-lived hook process.

import { openSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";

export function spawnServer(config: Config, logger: Logger): void {
  // Append server stdout/stderr to a logfile so a detached server isn't silent.
  let logFd: number | "ignore" = "ignore";
  try {
    logFd = openSync(join(config.dataDir, "server.out.log"), "a");
  } catch {
    logFd = "ignore";
  }

  try {
    const child = Bun.spawn([process.execPath, "serve"], {
      // Inherit env so BRAINTRUST_EVENT_SERVER_* / PLUGIN_DATA carry over.
      env: process.env,
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      // Detach so the server is not tied to this hook process's lifetime.
      // Bun keeps children unref'd by default; unref() is explicit and safe.
    });
    child.unref();
    logger.info("spawned server", { pid: child.pid, port: config.port });
  } catch (err) {
    logger.error("failed to spawn server", { error: String(err) });
  }
}
