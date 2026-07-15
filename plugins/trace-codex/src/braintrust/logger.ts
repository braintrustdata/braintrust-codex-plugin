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
import { PLUGIN_VERSION } from "../version.ts";

export type { Span, StartSpanArgs };

/**
 * The minimal, serializable identity of a span: enough to recreate a handle
 * bound to the same row after a restart, so further log()/end() calls merge into
 * the original span server-side (rows are keyed by span_id). Captured from a live
 * span's `spanId`/`rootSpanId`/`spanParents` getters (all synchronous).
 */
export interface SpanRef {
  spanId: string;
  rootSpanId: string;
  /** Parent span ids (empty for a root span). */
  spanParents: string[];
  /**
   * The span's name/type at capture time. Re-asserted on rehydration so the
   * merged row keeps the original attributes — without them the SDK would infer
   * a (wrong) name from the call stack when the rehydrated handle is created.
   */
  name?: string;
  type?: StartSpanArgs["type"];
  /**
   * The span's original start time (Unix seconds). Re-asserted on rehydration so
   * the merged row keeps its original start — without it the SDK stamps the start
   * to the moment of rehydration (the resume time), corrupting the span's timing.
   */
  startTime?: number;
}

/**
 * Capture a live span's identity for later rehydration. `name`/`type`/`startTime`
 * are the attributes the span was created with (the SDK doesn't expose them as
 * getters), passed by the caller so they can be re-asserted on resume.
 */
export function spanRef(
  span: Span,
  name?: string,
  type?: StartSpanArgs["type"],
  startTime?: number,
): SpanRef {
  return {
    spanId: span.spanId,
    rootSpanId: span.rootSpanId,
    spanParents: span.spanParents,
    ...(name !== undefined ? { name } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(startTime !== undefined ? { startTime } : {}),
  };
}

/** Creates root spans and can flush buffered events. */
export interface SpanFactory {
  startSpan(args: StartSpanArgs): Span;
  /**
   * Recreate a handle bound to an existing span's identity (see {@link SpanRef}).
   * The returned span carries the original span_id/root_span_id/parents, so
   * subsequent log()/end() calls merge into that row rather than creating a new
   * one. Used to resume a session's trace after the server restarted. The
   * returned handle is "naked": it logs nothing until the caller does.
   */
  rehydrateSpan(ref: SpanRef): Span;
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

type SpanOriginEnvironment = { type: string; name?: string };

function detectEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SpanOriginEnvironment | undefined {
  if (env.BRAINTRUST_ENVIRONMENT_TYPE) {
    return env.BRAINTRUST_ENVIRONMENT_NAME
      ? { type: env.BRAINTRUST_ENVIRONMENT_TYPE, name: env.BRAINTRUST_ENVIRONMENT_NAME }
      : { type: env.BRAINTRUST_ENVIRONMENT_TYPE };
  }
  if (env.GITHUB_ACTIONS) return { type: "ci", name: "github_actions" };
  if (env.GITLAB_CI) return { type: "ci", name: "gitlab_ci" };
  if (env.CIRCLECI) return { type: "ci", name: "circleci" };
  if (env.BUILDKITE) return { type: "ci", name: "buildkite" };
  if (env.CI) return { type: "ci", name: "ci" };
  if (env.VERCEL) return { type: "server", name: "vercel" };
  if (env.NETLIFY) return { type: "server", name: "netlify" };
  if (
    env.ECS_CONTAINER_METADATA_URI ||
    env.ECS_CONTAINER_METADATA_URI_V4 ||
    env.AWS_EXECUTION_ENV?.startsWith("AWS_ECS_")
  ) {
    return { type: "server", name: "ecs" };
  }
  if (env.AWS_LAMBDA_FUNCTION_NAME || env.AWS_EXECUTION_ENV?.startsWith("AWS_Lambda_")) {
    return { type: "server", name: "aws_lambda" };
  }
  if (env.NODE_ENV === "production" || env.NODE_ENV === "staging") {
    return { type: "server", name: env.NODE_ENV };
  }
  if (env.NODE_ENV === "development" || env.NODE_ENV === "local") {
    return { type: "local", name: env.NODE_ENV };
  }
  return undefined;
}

function pluginContext() {
  const environment = detectEnvironment();
  return {
    span_origin: {
      name: "braintrust.plugin.codex",
      version: PLUGIN_VERSION,
      instrumentation: { name: "codex-event-processor" },
      ...(environment ? { environment } : {}),
    },
  };
}

function withPluginContext(args: StartSpanArgs): StartSpanArgs {
  const event = (args.event ?? {}) as Record<string, unknown>;
  const eventWithContext = {
    ...event,
    context: {
      ...((event.context as Record<string, unknown> | undefined) ?? {}),
      ...pluginContext(),
    },
  } as StartSpanArgs["event"];
  return {
    ...args,
    event: eventWithContext,
  };
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
    startSpan: (args) => logger.startSpan(withPluginContext(args)),
    rehydrateSpan: (ref) =>
      logger.startSpan(
        withPluginContext({
          spanId: ref.spanId,
          parentSpanIds: { parentSpanIds: ref.spanParents, rootSpanId: ref.rootSpanId },
          ...(ref.name !== undefined ? { name: ref.name } : {}),
          ...(ref.type !== undefined ? { type: ref.type } : {}),
          ...(ref.startTime !== undefined ? { startTime: ref.startTime } : {}),
        }),
      ),
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
