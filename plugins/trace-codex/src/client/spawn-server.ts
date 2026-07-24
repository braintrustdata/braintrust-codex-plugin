// Spawn the background server by re-executing this binary with "serve".
//
// In a compiled standalone binary (pkg), process.execPath is the binary itself,
// so re-exec'ing it with "serve" runs the server entrypoint. We detach and
// unref the child so it outlives this short-lived hook process.

import { spawn } from "node:child_process";
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

  // Re-invoke the packaged app (not "node <script>"). pkg's child_process patch,
  // when it sees us spawn process.execPath, sets PKG_EXECPATH === the exec path
  // unless we pre-set it — which puts the child in node-compatibility mode and
  // makes it try to run "serve" as a script file (MODULE_NOT_FOUND). Pre-setting
  // PKG_EXECPATH to any value other than the exec path (and not the
  // "PKG_INVOKE_NODEJS" sentinel) makes pkg's bootstrap boot the packaged app
  // instead, with "serve" preserved as the mode argument. See @yao-pkg/pkg
  // prelude bootstrap.js (entrypoint selection) and bootstrap-shared.js (the
  // "already defined -> don't override" guard).
  const env = { ...process.env, PKG_EXECPATH: "codex-hook-child" };

  try {
    const child = spawn(process.execPath, ["serve"], {
      env,
      // stdin ignored; stdout/stderr to the logfile (or ignored if unopened).
      stdio: ["ignore", logFd, logFd],
      // Detach so the server is not tied to this hook process's lifetime.
      detached: true,
    });
    // Don't let the parent's event loop wait on the child.
    child.unref();
    logger.info("spawned server", { pid: child.pid, port: config.port });
  } catch (err) {
    logger.error("failed to spawn server", { error: String(err) });
  }
}
