import { describe, expect, it } from 'vitest';

type SpanRecord = {
  type: 'span';
  traceId: string;
  spanId: string;
  name: string;
  method: string;
  path: string;
  statusCode: number;
  startTimeMs: number;
  durationNs: number;
};

/** The slice of the view-model this test observes (typed locally: the module loads inside the test body). */
type WaterfallModelUnderTest = {
  readonly traces: readonly {
    readonly traceId: string;
    readonly rows: readonly { readonly spanId: string }[];
  }[];
};

type WaterfallModule = {
  buildWaterfall: (spans: readonly unknown[], maxTraces: number) => WaterfallModelUnderTest;
};

const BASE_MS = 1_700_000_000_000;

function traceIdOf(n: number): string {
  return `${String(n).padStart(2, '0')}${'e'.repeat(30)}`;
}

function makeSpan(trace: number, index: number, startOffsetMs: number): SpanRecord {
  const path = `/t${trace}/s${index}`;
  return {
    type: 'span',
    traceId: traceIdOf(trace),
    spanId: `${String(trace).padStart(2, '0')}${String(index).padStart(2, '0')}${'f'.repeat(12)}`,
    name: `GET ${path}`,
    method: 'GET',
    path,
    statusCode: 200,
    startTimeMs: BASE_MS + startOffsetMs,
    durationNs: 3_000_000,
  };
}

describe('dashboard trace waterfall — AC-2', () => {
  it('AC-2: given spans from more than N traces arriving in start order, returns exactly the N most recently started traces and none of the older ones', async () => {
    const { buildWaterfall } =
      (await import('./ui/waterfall-model.js')) as unknown as WaterfallModule;

    const maxTraces = 3;
    const traceCount = 7;
    const spans = Array.from({ length: traceCount }, (_, i) => makeSpan(i + 1, 1, i * 10));

    const model = buildWaterfall(spans, maxTraces);

    const kept = model.traces.map((trace) => trace.traceId);
    const newest = [traceIdOf(5), traceIdOf(6), traceIdOf(7)];
    const older = [traceIdOf(1), traceIdOf(2), traceIdOf(3), traceIdOf(4)];
    expect(kept).toHaveLength(maxTraces);
    expect([...kept].sort()).toEqual([...newest].sort());
    for (const id of older) {
      expect(kept, `older trace ${id} is dropped`).not.toContain(id);
    }
  });

  it('AC-2: counts traces, not spans — with two spans per trace it keeps exactly the N newest traces, each with all its spans', async () => {
    const { buildWaterfall } =
      (await import('./ui/waterfall-model.js')) as unknown as WaterfallModule;

    const maxTraces = 2;
    const traceCount = 5;
    // Spans arrive in start order; each trace's second span starts 2 ms after its first.
    const spans = Array.from({ length: traceCount }, (_, i) => [
      makeSpan(i + 1, 1, i * 10),
      makeSpan(i + 1, 2, i * 10 + 2),
    ]).flat();

    const model = buildWaterfall(spans, maxTraces);

    const kept = model.traces.map((trace) => trace.traceId);
    expect(kept).toHaveLength(maxTraces);
    expect([...kept].sort()).toEqual([traceIdOf(4), traceIdOf(5)].sort());
    for (const id of [traceIdOf(1), traceIdOf(2), traceIdOf(3)]) {
      expect(kept, `older trace ${id} is dropped`).not.toContain(id);
    }

    const keptSpanIds = model.traces.flatMap((trace) => trace.rows.map((row) => row.spanId));
    const expectedSpanIds = spans
      .filter((span) => span.traceId === traceIdOf(4) || span.traceId === traceIdOf(5))
      .map((span) => span.spanId);
    expect([...keptSpanIds].sort()).toEqual([...expectedSpanIds].sort());
  });
});
