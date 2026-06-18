// Runtime configuration, resolved from environment variables.
//
// All settings are codex-agnostic (this is a generic "event server"), so the
// env prefix is BRAINTRUST_EVENT_SERVER_*.

export interface Config {
  /** Host to bind the server to. Always loopback for now. */
  host: string;
  /** TCP port for the local event server. */
  port: number;
  /** Idle timeout: shut the server down after this long with no activity. */
  idleTimeoutMs: number;
  /** How often the idle watchdog checks for inactivity. */
  idleCheckIntervalMs: number;
  /** Directory for logs and pidfile. Defaults to PLUGIN_DATA, then a temp dir. */
  dataDir: string;
  /**
   * If set, every dequeued event is recorded as newline-delimited JSON to this
   * file (truncated on server start). Used to capture a session for later
   * `replay`. Unset (the default) means no recording.
   */
  recordFile?: string;
}

/** Default port chosen from the IANA dynamic/private range (49152-65535). */
export const DEFAULT_PORT = 52734;
/** Default idle timeout: 5 minutes. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Default watchdog cadence: every 30 seconds. */
export const DEFAULT_IDLE_CHECK_INTERVAL_MS = 30 * 1000;

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  // Codex sets PLUGIN_DATA to a writable per-plugin directory. Fall back to a
  // temp dir so the binary is still runnable standalone (tests, manual runs).
  return (
    env.BRAINTRUST_EVENT_SERVER_LOG_DIR ||
    env.PLUGIN_DATA ||
    `${env.TMPDIR || "/tmp"}/braintrust-event-server`
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: "127.0.0.1",
    port: parseIntEnv(env.BRAINTRUST_EVENT_SERVER_PORT, DEFAULT_PORT),
    idleTimeoutMs: parseIntEnv(
      env.BRAINTRUST_EVENT_SERVER_IDLE_TIMEOUT_MS,
      DEFAULT_IDLE_TIMEOUT_MS,
    ),
    idleCheckIntervalMs: parseIntEnv(
      env.BRAINTRUST_EVENT_SERVER_IDLE_CHECK_INTERVAL_MS,
      DEFAULT_IDLE_CHECK_INTERVAL_MS,
    ),
    dataDir: defaultDataDir(env),
    recordFile: env.BRAINTRUST_EVENT_SERVER_RECORD_FILE || undefined,
  };
}

/** Base URL for talking to the local server. */
export function serverBaseUrl(config: Pick<Config, "host" | "port">): string {
  return `http://${config.host}:${config.port}`;
}
