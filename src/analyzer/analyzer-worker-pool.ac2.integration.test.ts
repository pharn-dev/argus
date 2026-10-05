import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { describe, expect, it } from 'vitest';

type HeapSnapshotSummary = {
  nodeCount: number;
  totalSelfSize: number;
  top: Array<{ name: string; count: number; selfSize: number }>;
};

type SummaryModule = {
  summarizeHeapSnapshot: (
    path: string,
    options?: { top?: number; timeoutMs?: number },
  ) => Promise<HeapSnapshotSummary>;
};

class ArgusAc2SummaryMarkerInstance {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;

  constructor(seed: number) {
    this.a = seed;
    this.b = seed + 1;
    this.c = seed + 2;
    this.d = seed + 3;
    this.e = seed + 4;
    this.f = seed + 5;
    this.g = seed + 6;
    this.h = seed + 7;
  }
}

describe('analyzer heap-snapshot summary', () => {
  it('AC-2: summarizes a real heap snapshot with integer totals and the held class in the top list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-ac2-'));
    try {
      const held: ArgusAc2SummaryMarkerInstance[] = [];
      for (let i = 0; i < 10_000; i += 1) {
        held.push(new ArgusAc2SummaryMarkerInstance(i));
      }
      const snapshotPath = writeHeapSnapshot(join(dir, 'a.heapsnapshot'));
      expect(held.length).toBe(10_000);

      const mod = (await import('./index.js')) as unknown as SummaryModule;
      const summary = await mod.summarizeHeapSnapshot(snapshotPath, {
        top: 50,
        timeoutMs: 120_000,
      });

      expect(Number.isSafeInteger(summary.nodeCount)).toBe(true);
      expect(summary.nodeCount).toBeGreaterThan(0);
      expect(Number.isSafeInteger(summary.totalSelfSize)).toBe(true);
      expect(summary.totalSelfSize).toBeGreaterThan(0);

      expect(Array.isArray(summary.top)).toBe(true);
      expect(summary.top.length).toBeGreaterThan(0);
      expect(summary.top.length).toBeLessThanOrEqual(50);
      for (const entry of summary.top) {
        expect(typeof entry.name).toBe('string');
        expect(Number.isSafeInteger(entry.count)).toBe(true);
        expect(Number.isSafeInteger(entry.selfSize)).toBe(true);
      }
      for (let i = 1; i < summary.top.length; i += 1) {
        const previous = summary.top[i - 1];
        const current = summary.top[i];
        expect(previous?.selfSize).toBeGreaterThanOrEqual(current?.selfSize ?? Infinity);
      }

      const marker = summary.top.find((entry) => entry.name === 'ArgusAc2SummaryMarkerInstance');
      expect(marker).toBeDefined();
      expect(marker?.count).toBeGreaterThanOrEqual(10_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
