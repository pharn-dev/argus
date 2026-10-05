import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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

/** A valid aggregated window (all integer fields) starting at `start`. */
function makeWindow(start: number, seed: number): Record<string, unknown> {
  return {
    start,
    end: start + 1000,
    count: seed + 1,
    late: 0,
    eventLoop: { max: 30 + seed, p99: 20 + seed, mean: 10 + seed },
    memory: { heapUsedLast: 100 + seed, heapUsedMax: 200 + seed, rssLast: 300, rssMax: 400 },
    gc: { count: seed, totalPause: 2 * seed, maxPause: seed },
    backpressure: { events: 0, totalStall: 0, maxStall: 0 },
  };
}

type CollectorUnderTest = {
  readonly windows: { snapshot(): Array<Record<string, unknown>> };
  readonly persistence: { readonly skipped: number } | undefined;
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: {
    windowMs: number;
    capacity: number;
    persist?: { path: string; maxBytes: number };
  }) => CollectorUnderTest;
};

describe('collector persistence — AC-2', () => {
  it('AC-2: restores the most recent valid windows, skips a corrupt line and a truncated last line, then appends new windows after them', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const dir = await mkdtemp(join(tmpdir(), 'argus-persist-ac2-'));
    try {
      const path = join(dir, 'windows.ndjson');
      const stored = Array.from({ length: 12 }, (_, index) => makeWindow(index * 1000, index));
      const lines = stored.map((window) => JSON.stringify(window));
      // One line that is not valid JSON, between the valid ones.
      lines.splice(6, 0, '{"start": 6000, this is not json');
      const truncated = JSON.stringify(makeWindow(12_000, 12)).slice(0, 40);
      await writeFile(path, `${lines.join('\n')}\n${truncated}`, 'utf8');

      let collector: CollectorUnderTest | undefined;
      expect(() => {
        collector = collectorModule.createCollector({
          windowMs: 1000,
          capacity: 10,
          persist: { path, maxBytes: 1_000_000 },
        });
      }).not.toThrow();
      if (collector === undefined) {
        throw new Error('createCollector returned nothing');
      }

      await expect(
        collector.consume(
          Readable.from([20_100, 20_500, 21_100, 21_500].map((timestamp) => makeSample(timestamp))),
        ),
      ).resolves.toBeUndefined();

      expect(collector.persistence).toBeDefined();
      expect(collector.persistence?.skipped).toBe(2);

      const snapshot = collector.windows.snapshot();
      expect(snapshot).toHaveLength(10);
      expect(snapshot.slice(0, 8)).toEqual(stored.slice(4));
      expect(snapshot.slice(8).map((window) => window['start'])).toEqual([20_000, 21_000]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
