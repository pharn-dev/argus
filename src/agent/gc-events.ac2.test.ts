import { describe, expect, it } from 'vitest';

function expectNonNegativeInt(value: unknown, label: string): void {
  expect(typeof value, `${label} is a number`).toBe('number');
  expect(Number.isInteger(value), `${label} is an integer (got ${String(value)})`).toBe(true);
  expect(value as number, `${label} is non-negative`).toBeGreaterThanOrEqual(0);
}

describe('agent GC events — AC-2', () => {
  it('AC-2: the controller sample carries a gc part of non-negative integers alongside eventLoop and memory', async () => {
    const { createSamplerController } = await import('./index.js');

    const samples: unknown[] = [];
    let resolveFirst: () => void = () => undefined;
    const first = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const controller = createSamplerController((sample) => {
      samples.push(sample);
      resolveFirst();
    });

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
    }

    const sample = samples[0] as Record<string, unknown> | undefined;
    expect(sample).toBeDefined();
    if (sample === undefined) return;

    expect(sample['eventLoop'], 'eventLoop part').toBeDefined();
    expect(sample['memory'], 'memory part').toBeDefined();

    const gc = sample['gc'] as Record<string, unknown> | undefined;
    expect(gc, 'gc part').toBeDefined();
    if (gc === undefined) return;

    expectNonNegativeInt(gc['count'], 'gc.count');
    expectNonNegativeInt(gc['totalPause'], 'gc.totalPause');
    expectNonNegativeInt(gc['maxPause'], 'gc.maxPause');

    const kinds = gc['kinds'] as Record<string, unknown> | undefined;
    expect(kinds, 'gc.kinds').toBeDefined();
    if (kinds === undefined) return;
    for (const kind of ['minor', 'major', 'incremental', 'weakcb']) {
      expectNonNegativeInt(kinds[kind], `gc.kinds.${kind}`);
    }
  }, 10_000);
});
