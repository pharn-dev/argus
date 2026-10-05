import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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

type CollectorUnderTest = {
  readonly windows: { snapshot(): Array<Record<string, unknown>> };
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: {
    windowMs: number;
    capacity: number;
    persist?: { path: string; maxBytes: number };
  }) => CollectorUnderTest;
};

const WINDOW_COUNT = 8;

describe('collector persistence — AC-3', () => {
  it('AC-3: compacts the file to a contiguous tail of windows past maxBytes, surfaces append errors, and validates path and maxBytes', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const dir = await mkdtemp(join(tmpdir(), 'argus-persist-ac3-'));
    try {
      // Compaction past a small maxBytes.
      const path = join(dir, 'windows.ndjson');
      const collector = collectorModule.createCollector({
        windowMs: 1000,
        capacity: 3,
        persist: { path, maxBytes: 600 },
      });
      const timestamps = Array.from({ length: WINDOW_COUNT }, (_, index) => [
        index * 1000 + 100,
        index * 1000 + 600,
      ]).flat();
      await expect(
        collector.consume(Readable.from(timestamps.map((timestamp) => makeSample(timestamp)))),
      ).resolves.toBeUndefined();

      const consumedStarts = Array.from({ length: WINDOW_COUNT }, (_, index) => index * 1000);
      const text = await readFile(path, 'utf8');
      const fileLines = text.split('\n').filter((line) => line.length > 0);
      const parsed = fileLines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed.length).toBeLessThan(WINDOW_COUNT);
      const starts = parsed.map((window) => window['start']);
      expect(starts).toEqual(consumedStarts.slice(WINDOW_COUNT - parsed.length));
      for (const window of parsed) {
        expect(window['count']).toBe(2);
      }
      const last = collector.windows.snapshot().at(-1);
      expect(parsed.at(-1)).toEqual(last);
      expect(await readdir(dir)).toEqual(['windows.ndjson']);

      // Append errors surface: the persistence path is a directory.
      const failing = collectorModule.createCollector({
        windowMs: 1000,
        capacity: 3,
        persist: { path: dir, maxBytes: 600 },
      });
      await expect(
        failing.consume(Readable.from([100, 1100].map((timestamp) => makeSample(timestamp)))),
      ).rejects.toBeInstanceOf(Error);

      // Synchronous validation at creation.
      expect(() =>
        collectorModule.createCollector({
          windowMs: 1000,
          capacity: 3,
          persist: { path, maxBytes: 0 },
        }),
      ).toThrow(/maxBytes/);
      expect(() =>
        collectorModule.createCollector({
          windowMs: 1000,
          capacity: 3,
          persist: { path, maxBytes: -1 },
        }),
      ).toThrow(/maxBytes/);
      expect(() =>
        collectorModule.createCollector({
          windowMs: 1000,
          capacity: 3,
          persist: { path: '', maxBytes: 600 },
        }),
      ).toThrow(/path/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
