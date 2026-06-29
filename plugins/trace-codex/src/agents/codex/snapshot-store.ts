// Per-session snapshot store: persists each Codex session's resumable processor
// state to one JSON file under the plugin's writable data directory, so a
// restarted server can rehydrate the session's in-progress trace.
//
// This is Codex-owned (not part of the generic event server): *where* a plugin
// may persist state is the coding agent's call. Codex hands plugins a writable
// PLUGIN_DATA directory; that's our base. Each agent that wants resume support
// brings its own store with whatever location rules its host imposes.
//
// Like the event recorder and the span logger, this never throws: a persistence
// failure must not be able to break a Codex turn. Every operation is wrapped and
// failures are logged and swallowed. Writes are atomic (temp file + rename) so a
// crash mid-write can't leave a half-written snapshot that fails to parse.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Logger } from "../../log.ts";
import type { CodexSnapshot } from "./state-snapshot.ts";

/** Subdirectory of the data dir that holds per-session snapshots. */
const STATE_SUBDIR = "state";

/** Default age after which an orphaned snapshot is garbage-collected (7 days).
 * Orphans happen when a server crashes before a session's root span ends (which
 * is when the snapshot is normally deleted). */
export const DEFAULT_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve the plugin's writable data directory. Precedence matches the rest of
 * the plugin (server Config + settings): explicit override, then Codex's
 * PLUGIN_DATA, then a temp fallback so the binary still runs standalone.
 */
function dataDir(env: NodeJS.ProcessEnv): string {
  return (
    env.BRAINTRUST_EVENT_SERVER_LOG_DIR ||
    env.PLUGIN_DATA ||
    `${env.TMPDIR || "/tmp"}/braintrust-event-server`
  );
}

/**
 * Map a session id to its snapshot filename. Session ids are UUIDs, but sanitize
 * defensively so a stray id can never escape the state directory.
 */
function snapshotFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe}.json`;
}

export interface SnapshotStoreOptions {
  /** Override the data dir base. Defaults to the resolved PLUGIN_DATA. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Reads and writes per-session {@link CodexSnapshot}s under
 * `<dataDir>/state/<sessionId>.json`. All methods are best-effort and never
 * throw.
 */
export class SnapshotStore {
  private readonly dir: string;
  private readonly logger: Logger;

  constructor(logger: Logger, options: SnapshotStoreOptions = {}) {
    this.logger = logger;
    const base = options.dir ?? dataDir(options.env ?? process.env);
    this.dir = join(base, STATE_SUBDIR);
  }

  private pathFor(sessionId: string): string {
    return join(this.dir, snapshotFileName(sessionId));
  }

  /** Load a session's snapshot, or null if absent/unreadable/malformed. */
  read(sessionId: string): CodexSnapshot | null {
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(sessionId), "utf8");
    } catch {
      return null; // absent is the common case
    }
    try {
      return JSON.parse(raw) as CodexSnapshot;
    } catch (err) {
      this.logger.warn("snapshot store: malformed snapshot; ignoring", {
        sessionId,
        error: String(err),
      });
      return null;
    }
  }

  /** Persist a session's snapshot atomically. Never throws. */
  write(sessionId: string, snapshot: CodexSnapshot): void {
    const finalPath = this.pathFor(sessionId);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(tmpPath, JSON.stringify(snapshot));
      renameSync(tmpPath, finalPath);
    } catch (err) {
      this.logger.error("snapshot store: write failed", {
        sessionId,
        error: String(err),
      });
      // Best-effort cleanup of the temp file so it doesn't linger.
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // ignore
      }
    }
  }

  /** Delete a session's snapshot (e.g. once its root span has ended). */
  delete(sessionId: string): void {
    try {
      rmSync(this.pathFor(sessionId), { force: true });
    } catch (err) {
      this.logger.error("snapshot store: delete failed", {
        sessionId,
        error: String(err),
      });
    }
  }

  /**
   * Remove snapshots older than `ttlMs` (by file mtime). Called at server
   * startup to clean up orphans left by a previous crash. Never throws.
   */
  gcOlderThan(ttlMs: number = DEFAULT_SNAPSHOT_TTL_MS): void {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return; // no state dir yet: nothing to GC
    }
    const cutoff = Date.now() - ttlMs;
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const full = join(this.dir, name);
      try {
        if (statSync(full).mtimeMs < cutoff) {
          rmSync(full, { force: true });
          this.logger.debug("snapshot store: gc removed stale snapshot", { file: name });
        }
      } catch (err) {
        this.logger.debug("snapshot store: gc skip", { file: name, error: String(err) });
      }
    }
  }
}
