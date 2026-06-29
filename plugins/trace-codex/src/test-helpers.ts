// Shared test helpers.

import { _exportsForTestingOnly, initLogger } from "braintrust";
import type { Span, SpanFactory, SpanRef, StartSpanArgs } from "./braintrust/logger.ts";
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
    rehydrateSpan(ref: SpanRef): Span {
      const fake: FakeSpan = {
        id: ref.spanId,
        startArgs: {},
        flushCount: 0,
        endCount: 0,
      };
      spans.push(fake);
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
  tags?: string[];
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
      rehydrateSpan: (ref) =>
        logger.startSpan({
          spanId: ref.spanId,
          parentSpanIds: { parentSpanIds: ref.spanParents, rootSpanId: ref.rootSpanId },
          ...(ref.name !== undefined ? { name: ref.name } : {}),
          ...(ref.type !== undefined ? { type: ref.type } : {}),
          ...(ref.startTime !== undefined ? { startTime: ref.startTime } : {}),
        }),
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
  tags?: string[];
  metrics?: { start?: number; end?: number } & Record<string, number | undefined>;
  children: SpanTree[];
}

/**
 * Merge captured span rows that share a span_id into one logical span, the way
 * Braintrust merges rows server-side. Multiple rows for one span_id occur when a
 * span is logged across several calls (e.g. start, then output, then end) and
 * especially when a span is rehydrated after a server restart: the resumed
 * handle re-emits rows under the original id. Later non-empty fields win;
 * metadata and span_attributes are shallow-merged so partial updates accumulate.
 */
export function mergeCapturedSpans(spans: CapturedSpan[]): CapturedSpan[] {
  const byId = new Map<string, CapturedSpan>();
  const order: string[] = [];
  for (const span of spans) {
    const existing = byId.get(span.span_id);
    if (existing === undefined) {
      byId.set(span.span_id, { ...span });
      order.push(span.span_id);
      continue;
    }
    // Merge: later rows override, but don't clobber an existing value with
    // undefined (a partial row that omits a field shouldn't erase it).
    const merged: CapturedSpan = { ...existing };
    for (const [key, value] of Object.entries(span) as [keyof CapturedSpan, unknown][]) {
      if (value === undefined) continue;
      if (key === "metadata" || key === "span_attributes" || key === "metrics") {
        merged[key] = {
          ...(existing[key] as Record<string, unknown> | undefined),
          ...(value as Record<string, unknown>),
        } as never;
      } else {
        merged[key] = value as never;
      }
    }
    byId.set(span.span_id, merged);
  }
  return order.map((id) => byId.get(id) as CapturedSpan);
}

/** Build a single-rooted tree from flat captured spans (via span_parents). */
export function spansToTree(rawSpans: CapturedSpan[]): SpanTree | null {
  const spans = mergeCapturedSpans(rawSpans);
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
      tags: span.tags,
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
  /** If set, assert each listed tag is present on the span. */
  tags?: string[];
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

/** JSON.stringify with object keys sorted recursively, for order-insensitive
 * deep equality of plain data (objects/arrays/primitives). */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = sort((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
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
      // Compare with sorted keys so nested-object key order doesn't matter (the
      // SDK may reorder keys, e.g. when metadata is merged across log() calls).
      const a = canonicalJson(actual.metadata?.[key]);
      const e = canonicalJson(value);
      if (a !== e) diffs.push(`${path}.metadata.${key}: expected ${e}, got ${a}`);
    }
  }
  if (expected.tags !== undefined) {
    for (const tag of expected.tags) {
      if (!actual.tags?.includes(tag)) {
        diffs.push(
          `${path}.tags: expected to include "${tag}", got ${JSON.stringify(actual.tags)}`,
        );
      }
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
