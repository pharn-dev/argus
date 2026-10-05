import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type ControllerUnderTest = { start(intervalMs: number): void; stop(): void };

function expectNonNegativeInt(value: unknown, label: string): void {
  expect(typeof value, `${label} is a number`).toBe('number');
  expect(Number.isInteger(value), `${label} is an integer (got ${String(value)})`).toBe(true);
  expect(value as number, `${label} is non-negative`).toBeGreaterThanOrEqual(0);
}

describe('agent backpressure probes — AC-3', () => {
  it('AC-3: the controller sample carries a backpressure part of non-negative integers, and stop() restores Writable.prototype.write', async () => {
    const original = Writable.prototype.write;
    const agent = (await import('./index.js')) as unknown as Record<string, unknown>;
    const createSamplerController = agent['createSamplerController'] as (
      onSample: (sample: unknown) => void,
    ) => ControllerUnderTest;

    const samples: unknown[] = [];
    let resolveFirst: () => void = () => undefined;
    const first = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const controller = createSamplerController((sample) => {
      samples.push(sample);
      resolveFirst();
    });

    let restored: boolean;
    controller.start(50);
    try {
      await Promise.race([
        first,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no sample within 5000 ms')), 5000),
        ),
      ]);
    } finally {
      controller.stop();
      restored = Writable.prototype.write === original;
      Writable.prototype.write = original;
    }

    const sample = samples[0] as Record<string, unknown> | undefined;
    expect(sample).toBeDefined();
    if (sample === undefined) return;

    expect(sample['eventLoop'], 'eventLoop part').toBeDefined();
    expect(sample['memory'], 'memory part').toBeDefined();
    expect(sample['gc'], 'gc part').toBeDefined();

    const backpressure = sample['backpressure'] as Record<string, unknown> | undefined;
    expect(backpressure, 'backpressure part').toBeDefined();
    if (backpressure === undefined) return;

    expectNonNegativeInt(backpressure['events'], 'backpressure.events');
    expectNonNegativeInt(backpressure['totalStall'], 'backpressure.totalStall');
    expectNonNegativeInt(backpressure['maxStall'], 'backpressure.maxStall');

    const hotspots = backpressure['hotspots'];
    expect(Array.isArray(hotspots), 'backpressure.hotspots is a list').toBe(true);
    for (const [i, hotspot] of (hotspots as Record<string, unknown>[]).entries()) {
      expect(typeof hotspot['site'], `hotspots[${i}].site`).toBe('string');
      expectNonNegativeInt(hotspot['events'], `hotspots[${i}].events`);
      expectNonNegativeInt(hotspot['totalStall'], `hotspots[${i}].totalStall`);
      expectNonNegativeInt(hotspot['maxStall'], `hotspots[${i}].maxStall`);
    }

    expect(restored, 'Writable.prototype.write is the original after stop()').toBe(true);
  }, 10_000);
});
