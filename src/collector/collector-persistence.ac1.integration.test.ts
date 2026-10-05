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

/** Samples spanning the three consecutive windows 0, 1000 and 2000. */
const timestamps = [100, 500, 1100, 1500, 2100, 2500];

describe('collector persistence — AC-1', () => {
  it('AC-1: a persisting collector appends each closed window as one NDJSON line in ring order, and a collector without persist touches no file', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const persistDir = await mkdtemp(join(tmpdir(), 'argus-persist-ac1-'));
    const plainDir = await mkdtemp(join(tmpdir(), 'argus-persist-ac1-plain-'));
    try {
      const path = join(persistDir, 'windows.ndjson');
      const persisting = collectorModule.createCollector({
        windowMs: 1000,
        capacity: 10,
        persist: { path, maxBytes: 1_000_000 },
      });
      await expect(
        persisting.consume(Readable.from(timestamps.map((timestamp) => makeSample(timestamp)))),
      ).resolves.toBeUndefined();

      const snapshot = persisting.windows.snapshot();
      expect(snapshot.map((window) => window['start'])).toEqual([0, 1000, 2000]);

      const text = await readFile(path, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      const fileLines = text.split('\n').slice(0, -1);
      expect(fileLines).toHaveLength(3);
      expect(fileLines.map((line) => JSON.parse(line) as unknown)).toEqual(snapshot);

      const plain = collectorModule.createCollector({ windowMs: 1000, capacity: 10 });
      await expect(
        plain.consume(Readable.from(timestamps.map((timestamp) => makeSample(timestamp)))),
      ).resolves.toBeUndefined();
      expect(plain.windows.snapshot()).toHaveLength(3);
      expect(await readdir(plainDir)).toEqual([]);
    } finally {
      await rm(persistDir, { recursive: true, force: true });
      await rm(plainDir, { recursive: true, force: true });
    }
  }, 10_000);
});
