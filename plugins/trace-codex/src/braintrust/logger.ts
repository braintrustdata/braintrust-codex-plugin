// Thin wrapper around the Braintrust SDK.
//
// The SDK auto-configures from standard env vars (BRAINTRUST_API_KEY,
// BRAINTRUST_API_URL, BRAINTRUST_APP_URL), so no custom config is needed. When
// credentials are absent the SDK still creates spans locally and simply fails
// to flush — it does not throw — so callers can use it unconditionally.
//
// We expose a narrow SpanFactory interface (rather than the full SDK surface)
// so processors are easy to unit test with a fake.

import { initLogger, type Span, type StartSpanArgs } from "braintrust";
import type { Logger } from "../log.ts";

export type { Span, StartSpanArgs };

/** Creates root spans and can flush buffered events. */
export interface SpanFactory {
  startSpan(args: StartSpanArgs): Span;
  flush(): Promise<void>;
}

/**
 * How to report a session's traces to Braintrust. Resolved per session (e.g.
 * from a config event) so different sessions can log to different projects /
 * accounts. All fields optional; missing fields fall back to env / SDK defaults.
 */
export interface ReportingConfig {
  project?: string;
  apiKey?: string;
  apiUrl?: string;
  appUrl?: string;
  /** Master switch: when false, the session reports nothing to Braintrust. */
  traceToBraintrust?: boolean;
  /** Extra metadata merged into the root span (standard keys win on conflict). */
  additionalMetadata?: Record<string, unknown>;
}

/**
 * Builds a SpanFactory for a given reporting config. Injected into processors so
 * each session can create its own logger, and so tests can stay offline by
 * supplying a provider that returns a fake/captured factory.
 */
export type SpanFactoryProvider = (config?: ReportingConfig, diagLogger?: Logger) => SpanFactory;

/**
 * Project to log into. Precedence:
 *   explicit config  ->  BRAINTRUST_PROJECT  ->  BRAINTRUST_DEFAULT_PROJECT  ->  "codex"
 */
export function resolveProjectName(
  config?: ReportingConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return config?.project || env.BRAINTRUST_PROJECT || env.BRAINTRUST_DEFAULT_PROJECT || "codex";
}

/**
 * Creates a fresh SpanFactory backed by a new Braintrust SDK logger
 * (asyncFlush: true, so writes are batched and flushed in the background).
 *
 * When `config` is provided, its project/credentials are passed explicitly to
 * the SDK so this logger reports independently of process env (enabling
 * per-session routing). When omitted, the SDK auto-configures from env. Either
 * way the SDK no-ops offline (missing creds) rather than throwing.
 *
 * Not memoized — each call creates an isolated logger.
 */
export function createSpanFactory(config?: ReportingConfig, diagLogger?: Logger): SpanFactory {
  const projectName = resolveProjectName(config);
  const logger = initLogger({
    projectName,
    asyncFlush: true,
    ...(config?.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config?.appUrl ? { appUrl: config.appUrl } : {}),
  });
  diagLogger?.info("braintrust logger initialized", {
    projectName,
    apiUrl: config?.apiUrl ?? process.env.BRAINTRUST_API_URL ?? "https://api.braintrust.dev",
    hasApiKey: Boolean(config?.apiKey ?? process.env.BRAINTRUST_API_KEY),
  });
  return {
    startSpan: (args) => logger.startSpan(args),
    flush: async () => {
      try {
        await logger.flush();
        diagLogger?.debug("braintrust flush ok");
      } catch (err) {
        diagLogger?.error("braintrust flush failed", { error: String(err) });
        throw err;
      }
    },
  };
}

/** The default production provider: a fresh per-session logger from config. */
export const defaultSpanFactoryProvider: SpanFactoryProvider = (config, diagLogger) =>
  createSpanFactory(config, diagLogger);
