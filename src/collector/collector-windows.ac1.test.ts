import { once } from 'node:events';
import type { Transform } from 'node:stream';
import { describe, expect, it } from 'vitest';

type SampleInput = {
  timestamp: number;
  eventLoop: { max: number; mean: number; p99: number };
  memory: { heapUsed: number; rss: number };
  gc: { count: number; totalPause: number; maxPause: number };
  backpressure: { events: number; totalStall: number; maxStall: number };
};

/** Build a full AgentSample-shaped object from the fields the AC cares about. */
function makeSample(input: SampleInput): Record<string, unknown> {
  return {
    timestamp: input.timestamp,
    eventLoop: {
      min: 1,
      max: input.eventLoop.max,
      mean: input.eventLoop.mean,
      p50: input.eventLoop.mean,
      p99: input.eventLoop.p99,
    },
    memory: {
      heapUsed: input.memory.heapUsed,
      heapTotal: input.memory.heapUsed * 2,
      rss: input.memory.rss,
      external: 0,
      arrayBuffers: 0,
    },
    gc: {
      count: input.gc.count,
      totalPause: input.gc.totalPause,
      maxPause: input.gc.maxPause,
      kinds: { minor: input.gc.count, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: {
      events: input.backpressure.events,
      totalStall: input.backpressure.totalStall,
      maxStall: input.backpressure.maxStall,
      hotspots: [],
    },
  };
}

/** Collect every numeric leaf of a value, with its path. */
function numericLeaves(value: unknown, path = ''): Array<[string, number]> {
  if (typeof value === 'number') {
    return [[path, value]];
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      numericLeaves(child, path === '' ? key : `${path}.${key}`),
    );
  }
  return [];
}

function writeAndWait(stream: Transform, chunk: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

describe('collector windows — AC-1', () => {
  it('AC-1: groups three samples into the aligned 1000 window, emits it on the 2500 sample, and emits the 2000 window on end, all integers', async () => {
    const collectorModule = (await import('./index.js')) as unknown as {
      createWindowAggregator: (options: { windowMs: number }) => Transform;
    };
    const aggregator = collectorModule.createWindowAggregator({ windowMs: 1000 });

    const windows: Array<Record<string, unknown>> = [];
    aggregator.on('data', (window: Record<string, unknown>) => {
      windows.push(window);
    });
    const ended = once(aggregator, 'end');

    await writeAndWait(
      aggregator,
      makeSample({
        timestamp: 1000,
        eventLoop: { max: 50, mean: 10, p99: 40 },
        memory: { heapUsed: 100, rss: 1000 },
        gc: { count: 1, totalPause: 5, maxPause: 5 },
        backpressure: { events: 2, totalStall: 30, maxStall: 20 },
      }),
    );
    await writeAndWait(
      aggregator,
      makeSample({
        timestamp: 1400,
        eventLoop: { max: 70, mean: 11, p99: 35 },
        memory: { heapUsed: 300, rss: 3000 },
        gc: { count: 2, totalPause: 9, maxPause: 7 },
        backpressure: { events: 1, totalStall: 15, maxStall: 15 },
      }),
    );
    await writeAndWait(
      aggregator,
      makeSample({
        timestamp: 1999,
        eventLoop: { max: 60, mean: 11, p99: 55 },
        memory: { heapUsed: 200, rss: 2000 },
        gc: { count: 3, totalPause: 12, maxPause: 6 },
        backpressure: { events: 3, totalStall: 45, maxStall: 25 },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(windows).toHaveLength(0);

    await writeAndWait(
      aggregator,
      makeSample({
        timestamp: 2500,
        eventLoop: { max: 8, mean: 4, p99: 7 },
        memory: { heapUsed: 150, rss: 1500 },
        gc: { count: 0, totalPause: 0, maxPause: 0 },
        backpressure: { events: 0, totalStall: 0, maxStall: 0 },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    // The first window is emitted once the 2500 sample is written, before end.
    expect(windows).toHaveLength(1);

    aggregator.end();
    await ended;

    expect(windows).toHaveLength(2);
    const [first, second] = windows;

    expect(first).toMatchObject({
      start: 1000,
      end: 2000,
      count: 3,
      late: 0,
      eventLoop: { max: 70, p99: 55, mean: 10 },
      memory: { heapUsedLast: 200, heapUsedMax: 300, rssLast: 2000, rssMax: 3000 },
      gc: { count: 6, totalPause: 26, maxPause: 7 },
      backpressure: { events: 6, totalStall: 90, maxStall: 25 },
    });
    expect(second).toMatchObject({ start: 2000, end: 3000, count: 1 });

    for (const window of windows) {
      const leaves = numericLeaves(window);
      expect(leaves.length).toBeGreaterThan(0);
      for (const [path, value] of leaves) {
        expect(Number.isInteger(value), `${path} = ${String(value)} must be an integer`).toBe(true);
      }
    }
  }, 10_000);
});
