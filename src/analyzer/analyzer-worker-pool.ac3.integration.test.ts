import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { describe, expect, it } from 'vitest';

type HeapSnapshotDiff = {
  entries: Array<{ name: string; countDelta: number; selfSizeDelta: number }>;
  before: { nodeCount: number; totalSelfSize: number };
  after: { nodeCount: number; totalSelfSize: number };
};

type DiffModule = {
  diffHeapSnapshots: (
    beforePath: string,
    afterPath: string,
    options?: { top?: number; timeoutMs?: number },
  ) => Promise<HeapSnapshotDiff>;
};

class ArgusAc3DiffGrowthMarker {
  f0: number;
  f1: number;
  f2: number;
  f3: number;
  f4: number;
  f5: number;
  f6: number;
  f7: number;
  f8: number;
  f9: number;
  f10: number;
  f11: number;
  f12: number;
  f13: number;
  f14: number;
  f15: number;

  constructor(seed: number) {
    this.f0 = seed;
    this.f1 = seed + 1;
    this.f2 = seed + 2;
    this.f3 = seed + 3;
    this.f4 = seed + 4;
    this.f5 = seed + 5;
    this.f6 = seed + 6;
    this.f7 = seed + 7;
    this.f8 = seed + 8;
    this.f9 = seed + 9;
    this.f10 = seed + 10;
    this.f11 = seed + 11;
    this.f12 = seed + 12;
    this.f13 = seed + 13;
    this.f14 = seed + 14;
    this.f15 = seed + 15;
  }
}

describe('analyzer heap-snapshot diff', () => {
  it('AC-3: diffs two real heap snapshots and ranks the newly held class by self-size growth', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-ac3-'));
    try {
      const mod = (await import('./index.js')) as unknown as DiffModule;

      const beforePath = writeHeapSnapshot(join(dir, 'before.heapsnapshot'));

      const held: ArgusAc3DiffGrowthMarker[] = [];
      for (let i = 0; i < 5_000; i += 1) {
        held.push(new ArgusAc3DiffGrowthMarker(i));
      }
      const afterPath = writeHeapSnapshot(join(dir, 'after.heapsnapshot'));
      expect(held.length).toBe(5_000);

      const diff = await mod.diffHeapSnapshots(beforePath, afterPath, {
        top: 20,
        timeoutMs: 120_000,
      });

      expect(Array.isArray(diff.entries)).toBe(true);
      expect(diff.entries.length).toBeGreaterThan(0);
      expect(diff.entries.length).toBeLessThanOrEqual(20);
      for (const entry of diff.entries) {
        expect(typeof entry.name).toBe('string');
        expect(Number.isSafeInteger(entry.countDelta)).toBe(true);
        expect(Number.isSafeInteger(entry.selfSizeDelta)).toBe(true);
      }
      for (let i = 1; i < diff.entries.length; i += 1) {
        const previous = diff.entries[i - 1];
        const current = diff.entries[i];
        expect(previous?.selfSizeDelta).toBeGreaterThanOrEqual(current?.selfSizeDelta ?? Infinity);
      }

      const marker = diff.entries.find((entry) => entry.name === 'ArgusAc3DiffGrowthMarker');
      expect(marker).toBeDefined();
      expect(marker?.countDelta).toBeGreaterThanOrEqual(5_000);
      expect(marker?.selfSizeDelta).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
