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
type WaterfallRowUnderTest = {
  readonly traceId: string;
  readonly spanId: string;
  readonly offsetPct: number;
  readonly widthPct: number;
  readonly isError: boolean;
  readonly label: string;
};

type WaterfallTraceUnderTest = {
  readonly traceId: string;
  readonly rows: readonly WaterfallRowUnderTest[];
};

type WaterfallModelUnderTest = {
  readonly traces: readonly WaterfallTraceUnderTest[];
};

type WaterfallModule = {
  buildWaterfall: (spans: readonly unknown[], maxTraces: number) => WaterfallModelUnderTest;
};

const TRACE_A = 'a'.repeat(32);
const TRACE_B = 'b'.repeat(32);
const BASE_MS = 1_700_000_000_000;

function makeSpan(
  traceId: string,
  spanId: string,
  method: string,
  path: string,
  statusCode: number,
  startOffsetMs: number,
  durationNs: number,
): SpanRecord {
  return {
    type: 'span',
    traceId,
    spanId,
    name: `${method} ${path}`,
    method,
    path,
    statusCode,
    startTimeMs: BASE_MS + startOffsetMs,
    durationNs,
  };
}

describe('dashboard trace waterfall — AC-1', () => {
  it('AC-1: groups rows by trace id, one row per span, with offset and width proportional to start and duration in the visible range, a method/path/status/duration label, and only the 5xx row flagged as an error', async () => {
    const { buildWaterfall } =
      (await import('./ui/waterfall-model.js')) as unknown as WaterfallModule;

    // Durations are chosen so the ms figure reads the same however it is formatted (12.5, 7.5, 20.5).
    const okFirst = makeSpan(TRACE_A, 'a1'.repeat(8), 'GET', '/users', 200, 0, 12_500_000);
    const okSecond = makeSpan(TRACE_A, 'a2'.repeat(8), 'POST', '/orders', 200, 4, 7_500_000);
    const failing = makeSpan(TRACE_B, 'b1'.repeat(8), 'GET', '/slow', 503, 12, 20_500_000);
    const spans = [failing, okFirst, okSecond];

    const model = buildWaterfall(spans, 10);

    // The visible range: earliest start to latest end among the shown spans.
    const rangeStart = Math.min(...spans.map((span) => span.startTimeMs));
    const rangeEnd = Math.max(...spans.map((span) => span.startTimeMs + span.durationNs / 1e6));
    const rangeMs = rangeEnd - rangeStart;
    expect(rangeMs).toBeGreaterThan(0);

    // Grouped by trace id: one trace per distinct id, one row per span.
    expect(model.traces.map((trace) => trace.traceId).sort()).toEqual([TRACE_A, TRACE_B]);
    const allRows = model.traces.flatMap((trace) => trace.rows);
    expect(allRows).toHaveLength(spans.length);

    const traceA = model.traces.find((trace) => trace.traceId === TRACE_A);
    const traceB = model.traces.find((trace) => trace.traceId === TRACE_B);
    expect(traceA?.rows.map((row) => row.spanId).sort()).toEqual(
      [okFirst.spanId, okSecond.spanId].sort(),
    );
    expect(traceB?.rows.map((row) => row.spanId)).toEqual([failing.spanId]);
    for (const trace of model.traces) {
      for (const row of trace.rows) {
        expect(row.traceId, `row ${row.spanId} sits under its own trace`).toBe(trace.traceId);
      }
    }

    for (const span of spans) {
      const row = allRows.find((candidate) => candidate.spanId === span.spanId);
      expect(row, `row for span ${span.spanId}`).toBeDefined();
      if (row === undefined) {
        continue;
      }
      const durationMs = span.durationNs / 1e6;

      // Geometry, in percent of the visible range.
      expect(row.offsetPct, `${span.path} offset`).toBeCloseTo(
        ((span.startTimeMs - rangeStart) / rangeMs) * 100,
        6,
      );
      expect(row.widthPct, `${span.path} width`).toBeCloseTo((durationMs / rangeMs) * 100, 6);

      // The label names the method, path, status code and duration in ms.
      expect(row.label).toContain(span.method);
      expect(row.label).toContain(span.path);
      expect(row.label).toContain(String(span.statusCode));
      expect(row.label).toContain(String(durationMs));
      expect(row.label).toContain('ms');
    }

    // Only the 503 row is an error.
    const errorFlags = new Map(allRows.map((row) => [row.spanId, row.isError]));
    expect(errorFlags.get(failing.spanId)).toBe(true);
    expect(errorFlags.get(okFirst.spanId)).toBe(false);
    expect(errorFlags.get(okSecond.spanId)).toBe(false);
  });
});
