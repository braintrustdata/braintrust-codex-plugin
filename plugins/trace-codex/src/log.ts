// Minimal append-only logger. Writes newline-delimited JSON to a file under the
// data dir, and mirrors to stderr. Never throws: logging must not be able to
// break the hook or crash the server.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  /** Directory to write the log file into. */
  dataDir: string;
  /** Log file name. */
  fileName?: string;
  /** Component tag included on every line (e.g. "server", "hook"). */
  component: string;
}

function safeMkdir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore: we fall back to stderr-only
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const fileName = options.fileName ?? "event-server.log";
  safeMkdir(options.dataDir);
  const filePath = join(options.dataDir, fileName);

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: options.component,
      pid: process.pid,
      message,
      ...fields,
    });
    try {
      appendFileSync(filePath, `${line}\n`);
    } catch {
      // ignore file errors
    }
    // Mirror to stderr so it surfaces in foreground/dev runs without polluting
    // stdout (which the hook protocol may read).
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      // ignore
    }
  };

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
