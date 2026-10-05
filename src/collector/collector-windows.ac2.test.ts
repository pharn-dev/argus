import { once } from 'node:events';
import type { Transform } from 'node:stream';
import { describe, expect, it } from 'vitest';

/** A full AgentSample-shaped object at the given timestamp. */
function makeSample(timestamp: number): Record<string, unknown> {
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
  };
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

type EmittedWindow = { start: number; count: number; late: number };

describe('collector windows — AC-2', () => {
  it('AC-2: late samples are counted on the open window and dropped; a closed window is never re-opened or re-emitted', async () => {
    const collectorModule = (await import('./index.js')) as unknown as {
      createWindowAggregator: (options: { windowMs: number }) => Transform;
    };
    const aggregator = collectorModule.createWindowAggregator({ windowMs: 1000 });

    const windows: EmittedWindow[] = [];
    aggregator.on('data', (window: EmittedWindow) => {
      windows.push(window);
    });
    const ended = once(aggregator, 'end');

    for (const timestamp of [1500, 2100, 1200, 900, 2200, 3100]) {
      await writeAndWait(aggregator, makeSample(timestamp));
    }
    aggregator.end();
    await ended;

    const starts = windows.map((window) => window.start);
    expect(starts.filter((start) => start === 1000)).toHaveLength(1);
    expect(starts).not.toContain(0);

    const window2000 = windows.filter((window) => window.start === 2000);
    expect(window2000).toHaveLength(1);
    expect(window2000[0]).toMatchObject({ start: 2000, count: 2, late: 2 });

    const window3000 = windows.filter((window) => window.start === 3000);
    expect(window3000).toHaveLength(1);
    expect(window3000[0]).toMatchObject({ start: 3000, late: 0 });
  }, 10_000);
});
