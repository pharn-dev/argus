import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type IgnoredReason = 'foreign' | 'malformed';

type CollectorUnderTest = {
  readonly windows: { snapshot(): unknown[] };
  readonly spans: { snapshot(): unknown[] };
  readonly ignored: number;
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: {
    windowMs: number;
    capacity: number;
    onIgnored?: (record: unknown, reason: IgnoredReason) => void;
  }) => CollectorUnderTest;
};

/** A full agent sample line object at the given timestamp. */
function makeSample(timestamp: number | null): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: 20, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 100, heapTotal: 200, rss: 1000, external: 0, arrayBuffers: 0 },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
    dropped: { samples: 0, spans: 0 },
  };
}

const span = {
  type: 'span',
  traceId: 'c'.repeat(32),
  spanId: 'd'.repeat(16),
  name: 'GET /orders',
  method: 'GET',
  path: '/orders',
  statusCode: 200,
  startTimeMs: 1_700_000_000_000,
  durationNs: 2_000_000,
};
const pino = { level: 30, time: 1_700_000_000_000, msg: 'hi' };
const foo = { foo: 1 };
const malformed = makeSample(null);

describe('collector record guard — AC-2', () => {
  it('AC-2: consume() resolves over mixed records, aggregates only the samples, keeps the span, and skips and counts 3 records (malformed only for the sample-shaped one)', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const calls: Array<{ record: unknown; reason: IgnoredReason }> = [];
    const collector = collectorModule.createCollector({
      windowMs: 1000,
      capacity: 10,
      onIgnored(record, reason) {
        calls.push({ record, reason });
      },
    });

    const records: unknown[] = [
      makeSample(1000),
      pino,
      span,
      makeSample(1500),
      foo,
      malformed,
      makeSample(2500),
    ];

    await expect(collector.consume(Readable.from(records))).resolves.toBeUndefined();

    const windows = collector.windows.snapshot() as Array<{ start: number; count: number }>;
    expect(windows.map((window) => ({ start: window.start, count: window.count }))).toEqual([
      { start: 1000, count: 2 },
      { start: 2000, count: 1 },
    ]);

    expect(collector.spans.snapshot()).toEqual([span]);

    expect(collector.ignored).toBe(3);
    expect(Number.isInteger(collector.ignored)).toBe(true);

    expect(calls).toHaveLength(3);
    const malformedCalls = calls.filter((call) => call.reason === 'malformed');
    expect(malformedCalls).toHaveLength(1);
    expect(malformedCalls[0]?.record).toEqual(malformed);
    const foreignRecords = calls
      .filter((call) => call.reason === 'foreign')
      .map((call) => call.record);
    expect(foreignRecords).toEqual([pino, foo]);
  }, 10_000);
});
