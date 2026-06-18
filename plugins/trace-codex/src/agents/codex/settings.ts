// User settings layer.
//
// Codex has no native mechanism to pass custom settings into plugin hooks (it
// only provides PLUGIN_ROOT / PLUGIN_DATA). So we read our own config.json from
// the plugin's writable data directory (PLUGIN_DATA) and map its friendly keys
// onto the BRAINTRUST_* / BRAINTRUST_EVENT_SERVER_* environment variables that
// the rest of the code (and the Braintrust SDK) already understand.
//
// Precedence: environment variables always win over the file, so power users
// and CI can override the file without editing it. The file is optional;
// missing or malformed files are ignored (never throw).

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Friendly, camelCase settings a user can put in config.json. All optional. */
export interface Settings {
  /** Braintrust API key. */
  apiKey?: string;
  /** Braintrust API URL (override for self-hosted/staging). */
  apiUrl?: string;
  /** Braintrust app URL. */
  appUrl?: string;
  /** Project to log traces into. */
  project?: string;
  /** Master switch: when false or unset, no traces are reported to Braintrust. */
  traceToBraintrust?: boolean;
  /** Extra metadata merged into the root span (standard keys win on conflict). */
  additionalMetadata?: Record<string, unknown>;
  /** If set, record every event to this NDJSON file (for replay). */
  recordFile?: string;
  /** Local event server port. */
  port?: number;
  /** Idle timeout (ms) before the background server shuts down. */
  idleTimeoutMs?: number;
  /** How often (ms) the idle watchdog checks for inactivity. */
  idleCheckIntervalMs?: number;
}

/** Maps each setting to the environment variable it populates. */
export const SETTINGS_TO_ENV: Record<keyof Settings, string> = {
  apiKey: "BRAINTRUST_API_KEY",
  apiUrl: "BRAINTRUST_API_URL",
  appUrl: "BRAINTRUST_APP_URL",
  project: "BRAINTRUST_PROJECT",
  traceToBraintrust: "TRACE_TO_BRAINTRUST",
  additionalMetadata: "BRAINTRUST_ADDITIONAL_METADATA",
  recordFile: "BRAINTRUST_EVENT_SERVER_RECORD_FILE",
  port: "BRAINTRUST_EVENT_SERVER_PORT",
  idleTimeoutMs: "BRAINTRUST_EVENT_SERVER_IDLE_TIMEOUT_MS",
  idleCheckIntervalMs: "BRAINTRUST_EVENT_SERVER_IDLE_CHECK_INTERVAL_MS",
};

const SETTING_KEYS = Object.keys(SETTINGS_TO_ENV) as Array<keyof Settings>;

const NUMBER_KEYS = new Set<keyof Settings>(["port", "idleTimeoutMs", "idleCheckIntervalMs"]);

/**
 * The plugin's writable data directory, where config.json lives. Resolved
 * independently of the server Config layer so settings detection stays its own
 * layer. Precedence matches the server's data dir: explicit log dir override,
 * then Codex's PLUGIN_DATA, then a temp fallback.
 */
function dataDir(env: NodeJS.ProcessEnv): string {
  return (
    env.BRAINTRUST_EVENT_SERVER_LOG_DIR ||
    env.PLUGIN_DATA ||
    `${env.TMPDIR || "/tmp"}/braintrust-event-server`
  );
}

/** Absolute path to the user's config.json (in the plugin data dir). */
export function settingsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), "config.json");
}

/**
 * Read and parse config.json. Returns the recognized settings, or {} if the
 * file is missing, unreadable, or malformed. Never throws.
 */
export function loadSettingsFile(path: string): Settings {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {}; // missing/unreadable is fine — the file is optional
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // malformed JSON: ignore rather than break the hook
  }

  if (typeof parsed !== "object" || parsed === null) return {};
  const obj = parsed as Record<string, unknown>;

  const settings: Settings = {};
  for (const key of SETTING_KEYS) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    if (NUMBER_KEYS.has(key)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        (settings as Record<string, unknown>)[key] = value;
      }
    } else if (key === "traceToBraintrust") {
      if (typeof value === "boolean") settings.traceToBraintrust = value;
    } else if (key === "additionalMetadata") {
      if (typeof value === "object" && !Array.isArray(value)) {
        settings.additionalMetadata = value as Record<string, unknown>;
      }
    } else if (typeof value === "string" && value.length > 0) {
      (settings as Record<string, unknown>)[key] = value;
    }
  }
  return settings;
}

/**
 * Apply settings to the environment: for each setting, set its env var only if
 * that var is not already set (environment wins). Mutates `env`. Returns the
 * list of setting keys that were applied, for diagnostics (never includes
 * values, so secrets are not logged).
 */
export function applySettingsToEnv(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): Array<keyof Settings> {
  const applied: Array<keyof Settings> = [];
  for (const key of SETTING_KEYS) {
    const value = settings[key];
    if (value === undefined) continue;
    const envVar = SETTINGS_TO_ENV[key];
    if (env[envVar]) continue; // environment wins
    // Objects (additionalMetadata) are serialized as JSON; everything else
    // stringifies directly (booleans -> "true"/"false", numbers, strings).
    env[envVar] = typeof value === "object" ? JSON.stringify(value) : String(value);
    applied.push(key);
  }
  return applied;
}
