import { once } from 'node:events';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type HotspotUnderTest = { site: string; events: number; totalStall: number; maxStall: number };
type SampleUnderTest = {
  events: number;
  totalStall: number;
  maxStall: number;
  hotspots: HotspotUnderTest[];
};
type ProbeUnderTest = { enable(): void; disable(): void; sample(): SampleUnderTest };

const DEFAULT_MAX_HOTSPOTS = 10;

function expectNonNegativeInt(value: unknown, label: string): void {
  expect(typeof value, `${label} is a number`).toBe('number');
  expect(Number.isInteger(value), `${label} is an integer (got ${String(value)})`).toBe(true);
  expect(value as number, `${label} is non-negative`).toBeGreaterThanOrEqual(0);
}

/** A Writable with a 1-byte highWaterMark whose consumer acknowledges each chunk after a delay. */
function createSlowWritable(delayMs: number): Writable {
  return new Writable({
    highWaterMark: 1,
    write(_chunk: Buffer | string, _encoding, callback) {
      setTimeout(() => callback(), delayMs);
    },
  });
}

/** Write until write() returns false, then wait for 'drain'. One full stall. */
async function stallOnce(stream: Writable): Promise<void> {
  let accepted = true;
  let guard = 0;
  while (accepted) {
    accepted = stream.write('x');
    guard += 1;
    if (guard > 1000) throw new Error('write() never returned false');
  }
  await once(stream, 'drain');
}

describe('agent backpressure probes — AC-1', () => {
  it('AC-1: an enabled probe reports the stalls of a slow Writable with integer totals, a test-file site hotspot, then resets', async () => {
    const mod = (await import('./index.js')) as unknown as Record<string, unknown>;
    const createBackpressureProbe = mod['createBackpressureProbe'] as (options?: {
      maxHotspots?: number;
    }) => ProbeUnderTest;
    expect(typeof createBackpressureProbe).toBe('function');

    const STALLS = 3;
    const probe = createBackpressureProbe();
    probe.enable();
    let first: SampleUnderTest;
    let second: SampleUnderTest;
    try {
      const stream = createSlowWritable(5);
      for (let i = 0; i < STALLS; i += 1) {
        await stallOnce(stream);
      }
      first = probe.sample();
      second = probe.sample();
      stream.destroy();
    } finally {
      probe.disable();
    }

    // First read: the window holds exactly the test's stalls.
    expect(first.events).toBe(STALLS);
    expectNonNegativeInt(first.totalStall, 'totalStall');
    expectNonNegativeInt(first.maxStall, 'maxStall');
    expect(first.maxStall).toBeLessThanOrEqual(first.totalStall);

    expect(Array.isArray(first.hotspots)).toBe(true);
    expect(first.hotspots.length).toBeGreaterThan(0);
    expect(first.hotspots.length).toBeLessThanOrEqual(DEFAULT_MAX_HOTSPOTS);
    for (let i = 1; i < first.hotspots.length; i += 1) {
      const previous = first.hotspots[i - 1] as HotspotUnderTest;
      const current = first.hotspots[i] as HotspotUnderTest;
      expect(previous.totalStall).toBeGreaterThanOrEqual(current.totalStall);
    }

    const sitePattern = /backpressure-probes\.ac1\.integration\.test\.ts:\d+$/;
    const entry = first.hotspots.find((h) => sitePattern.test(h.site));
    expect(
      entry,
      `a hotspot naming this test file; got ${JSON.stringify(first.hotspots)}`,
    ).toBeDefined();
    if (entry === undefined) return;
    expect(entry.site).not.toMatch(/(?:^node:)|(?:internal\/)/);
    expect(entry.site).not.toMatch(/backpressure-probe\.ts|stack-site\.ts/);
    expect(entry.events).toBe(STALLS);
    expectNonNegativeInt(entry.totalStall, 'hotspot.totalStall');
    expectNonNegativeInt(entry.maxStall, 'hotspot.maxStall');
    expect(entry.maxStall).toBeLessThanOrEqual(entry.totalStall);

    // Second read: the window was reset.
    expect(second.events).toBe(0);
    expect(second.totalStall).toBe(0);
    expect(second.maxStall).toBe(0);
    expect(second.hotspots).toEqual([]);
  }, 10_000);
});
