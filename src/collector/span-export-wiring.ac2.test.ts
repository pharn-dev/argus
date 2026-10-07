import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type AlertRuleInput = {
  id: string;
  metric: string;
  comparison: string;
  threshold: number;
  forWindows?: number;
};

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

type CollectorUnderTest = {
  readonly windows: { snapshot(): unknown[] };
  readonly alerts: { snapshot(): unknown[] };
  readonly spans: { snapshot(): unknown[] };
  subscribe(listener: { span?(span: SpanRecord): void }): () => void;
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: {
    windowMs: number;
    capacity: number;
    spanCapacity?: number;
    alerts?: readonly AlertRuleInput[];
  }) => CollectorUnderTest;
};

/** A full AgentSample-shaped object at the given timestamp with the given event-loop max. */
function makeSample(timestamp: number, eventLoopMax: number): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: eventLoopMax, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 100, heapTotal: 200, rss: 1000, external: 0, arrayBuffers: 0 },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  };
}

function makeSpan(n: number, path: string, statusCode: number): SpanRecord {
  return {
    type: 'span',
    traceId: `${String(n).padStart(2, '0')}${'a'.repeat(30)}`,
    spanId: `${String(n).padStart(2, '0')}${'b'.repeat(14)}`,
    name: `GET ${path}`,
    method: 'GET',
    path,
    statusCode,
    startTimeMs: 1_700_000_000_000 + n,
    durationNs: 1_000 * n,
  };
}

const rules: AlertRuleInput[] = [
  { id: 'loop-max', metric: 'eventLoop.max', comparison: '>', threshold: 100 },
];

const samples = [
  makeSample(100, 50),
  makeSample(500, 40),
  makeSample(1100, 500),
  makeSample(1600, 300),
  makeSample(2100, 50),
  makeSample(2700, 20),
];

const spans = [
  makeSpan(1, '/one', 200),
  makeSpan(2, '/two', 404),
  makeSpan(3, '/three', 200),
  makeSpan(4, '/four', 500),
];

/** Samples interleaved with the four span records, spans between and around samples. */
const interleaved: unknown[] = [
  samples[0],
  spans[0],
  samples[1],
  samples[2],
  spans[1],
  samples[3],
  spans[2],
  samples[4],
  samples[5],
  spans[3],
];

describe('collector span ring — AC-2', () => {
  it('AC-2: a collector with spanCapacity 2 keeps the last two spans, notifies a subscriber of all four in order, and its windows and alerts match a samples-only collector', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const withSpans = collectorModule.createCollector({
      windowMs: 1000,
      capacity: 10,
      spanCapacity: 2,
      alerts: rules,
    });
    const received: SpanRecord[] = [];
    const unsubscribe = withSpans.subscribe({
      span(span: SpanRecord) {
        received.push(span);
      },
    });
    await expect(withSpans.consume(Readable.from(interleaved))).resolves.toBeUndefined();
    unsubscribe();

    const samplesOnly = collectorModule.createCollector({
      windowMs: 1000,
      capacity: 10,
      alerts: rules,
    });
    await expect(samplesOnly.consume(Readable.from(samples))).resolves.toBeUndefined();

    expect(withSpans.spans, 'the collector exposes a span ring').toBeDefined();
    expect(withSpans.spans.snapshot()).toEqual([spans[2], spans[3]]);
    expect(received).toEqual(spans);

    const referenceWindows = samplesOnly.windows.snapshot();
    const referenceAlerts = samplesOnly.alerts.snapshot();
    expect(referenceWindows.length).toBeGreaterThanOrEqual(1);
    expect(referenceAlerts.length).toBeGreaterThanOrEqual(1);
    expect(withSpans.windows.snapshot()).toEqual(referenceWindows);
    expect(withSpans.alerts.snapshot()).toEqual(referenceAlerts);
  }, 10_000);
});
