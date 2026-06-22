// Shared test helpers.

import { _exportsForTestingOnly, initLogger } from "braintrust";
import type { Span, SpanFactory, StartSpanArgs } from "./braintrust/logger.ts";
import type { Logger } from "./log.ts";

/** A no-op logger for tests; never touches the filesystem. */
export function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/** A fake span that records calls; stands in for a Braintrust Span. */
export interface FakeSpan {
  id: string;
  startArgs: StartSpanArgs;
  flushCount: number;
  endCount: number;
}

/** A fake SpanFactory capturing the spans it creates, for offline tests. */
export interface FakeSpanFactory extends SpanFactory {
  spans: FakeSpan[];
  factoryFlushCount: number;
}

export function createFakeSpanFactory(): FakeSpanFactory {
  const spans: FakeSpan[] = [];
  const factory: FakeSpanFactory = {
    spans,
    factoryFlushCount: 0,
    startSpan(args: StartSpanArgs): Span {
      const fake: FakeSpan = {
        id: `span-${spans.length + 1}`,
        startArgs: args,
        flushCount: 0,
        endCount: 0,
      };
      spans.push(fake);
      // Only the members the processor uses are needed; cast through unknown.
      return {
        id: fake.id,
        flush: async () => {
          fake.flushCount += 1;
        },
        end: () => {
          fake.endCount += 1;
          return 0;
        },
      } as unknown as Span;
    },
    flush: async () => {
      factory.factoryFlushCount += 1;
    },
  };
  return factory;
}

// ============================================================================
// Captured-trace harness
//
// Uses the Braintrust SDK's own test facility to capture the spans the SDK
// would have flushed, so tests assert on real span output (span_id,
// root_span_id, span_parents, span_attributes, input, metadata, metrics)
// rather than a hand-rolled struct.
// ============================================================================

// A non-real but well-formed UUID. Passing both projectName and projectId makes
// the SDK skip network project resolution (see computeLoggerMetadata).
const TEST_PROJECT_ID = "00000000-0000-0000-0000-000000000000";

// biome-ignore lint/suspicious/noExplicitAny: _exportsForTestingOnly is untyped.
const testOnly = _exportsForTestingOnly as any;

/** A single span event as captured by the SDK test logger. */
export interface CapturedSpan {
  span_id: string;
  root_span_id: string;
  span_parents?: string[];
  span_attributes?: { name?: string; type?: string };
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  metrics?: { start?: number; end?: number } & Record<string, number | undefined>;
}

export interface CapturedTrace {
  /** A real SDK-backed SpanFactory writing into the test logger. */
  spanFactory: SpanFactory;
  /** Drain the captured span events. */
  drain(): Promise<CapturedSpan[]>;
  /** Tear down the test logger. */
  cleanup(): void;
}

/** Install the SDK test logger and return a SpanFactory + drain/cleanup. */
export function withCapturedTrace(): CapturedTrace {
  testOnly.simulateLoginForTests();
  const bg = testOnly.useTestBackgroundLogger();
  const logger = initLogger({
    projectName: "codex-test",
    projectId: TEST_PROJECT_ID,
    asyncFlush: true,
  });
  return {
    spanFactory: {
      startSpan: (args) => logger.startSpan(args),
      flush: () => logger.flush(),
    },
    drain: async () => {
      await logger.flush();
      return (await bg.drain()) as CapturedSpan[];
    },
    cleanup: () => testOnly.clearTestBackgroundLogger(),
  };
}

// ============================================================================
// Span tree
// ============================================================================

export interface SpanTree {
  span_id: string;
  root_span_id: string;
  name?: string;
  type?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  metrics?: { start?: number; end?: number } & Record<string, number | undefined>;
  children: SpanTree[];
}

/** Build a single-rooted tree from flat captured spans (via span_parents). */
export function spansToTree(spans: CapturedSpan[]): SpanTree | null {
  if (spans.length === 0) return null;

  const root = spans.find(
    (s) => !s.span_parents || s.span_parents.length === 0 || s.span_parents[0] === s.span_id,
  );
  if (!root) return null;

  const childrenByParent = new Map<string, CapturedSpan[]>();
  for (const span of spans) {
    const parentId = span.span_parents?.[0];
    if (parentId && parentId !== span.span_id) {
      const list = childrenByParent.get(parentId) ?? [];
      list.push(span);
      childrenByParent.set(parentId, list);
    }
  }

  const build = (span: CapturedSpan): SpanTree => {
    const children = (childrenByParent.get(span.span_id) ?? [])
      .map((c) => ({ span: c, index: spans.indexOf(c) }))
      .sort((a, b) => {
        const aStart = a.span.metrics?.start ?? 0;
        const bStart = b.span.metrics?.start ?? 0;
        return aStart !== bStart ? aStart - bStart : a.index - b.index;
      })
      .map((entry) => build(entry.span));
    return {
      span_id: span.span_id,
      root_span_id: span.root_span_id,
      name: span.span_attributes?.name,
      type: span.span_attributes?.type,
      input: span.input,
      output: span.output,
      metadata: span.metadata,
      metrics: span.metrics,
      children,
    };
  };

  return build(root);
}

// ============================================================================
// Expected-trace matcher
// ============================================================================

export interface ExpectedSpan {
  span_attributes?: { name?: string | RegExp; type?: string };
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  /** If set, assert whether the span has an end time (true) or not (false). */
  ended?: boolean;
  /** If set, assert exact start/end metric values (Unix seconds). */
  metrics?: { start?: number; end?: number } & Record<string, number | undefined>;
  /** Exact list of children (length and order are checked). */
  children?: ExpectedSpan[];
}

function nameMatches(actual: string | undefined, expected: string | RegExp): boolean {
  return expected instanceof RegExp ? expected.test(actual ?? "") : actual === expected;
}

export function diffSpan(actual: SpanTree | null, expected: ExpectedSpan, path: string): string[] {
  const diffs: string[] = [];
  if (actual === null) {
    diffs.push(`${path}: expected a span, got none`);
    return diffs;
  }

  if (
    expected.span_attributes?.name !== undefined &&
    !nameMatches(actual.name, expected.span_attributes.name)
  ) {
    diffs.push(
      `${path}.name: expected ${String(expected.span_attributes.name)}, got ${String(actual.name)}`,
    );
  }
  if (
    expected.span_attributes?.type !== undefined &&
    actual.type !== expected.span_attributes.type
  ) {
    diffs.push(
      `${path}.type: expected ${expected.span_attributes.type}, got ${String(actual.type)}`,
    );
  }
  if (expected.input !== undefined) {
    const a = JSON.stringify(actual.input);
    const e = JSON.stringify(expected.input);
    if (a !== e) diffs.push(`${path}.input: expected ${e}, got ${a}`);
  }
  if (expected.output !== undefined) {
    const a = JSON.stringify(actual.output);
    const e = JSON.stringify(expected.output);
    if (a !== e) diffs.push(`${path}.output: expected ${e}, got ${a}`);
  }
  if (expected.metadata !== undefined) {
    for (const [key, value] of Object.entries(expected.metadata)) {
      const a = JSON.stringify(actual.metadata?.[key]);
      const e = JSON.stringify(value);
      if (a !== e) diffs.push(`${path}.metadata.${key}: expected ${e}, got ${a}`);
    }
  }
  if (expected.ended !== undefined) {
    const isEnded = actual.metrics?.end !== undefined;
    if (isEnded !== expected.ended) {
      diffs.push(`${path}.ended: expected ${expected.ended}, got ${isEnded}`);
    }
  }
  if (expected.metrics !== undefined) {
    for (const [key, value] of Object.entries(expected.metrics)) {
      if (value === undefined) continue;
      const actualValue = actual.metrics?.[key];
      if (actualValue !== value) {
        diffs.push(`${path}.metrics.${key}: expected ${value}, got ${String(actualValue)}`);
      }
    }
  }
  if (expected.children !== undefined) {
    if (actual.children.length !== expected.children.length) {
      diffs.push(
        `${path}.children.length: expected ${expected.children.length}, got ${actual.children.length}`,
      );
    } else {
      for (let i = 0; i < expected.children.length; i++) {
        diffs.push(...diffSpan(actual.children[i], expected.children[i], `${path}.children[${i}]`));
      }
    }
  }
  return diffs;
}
