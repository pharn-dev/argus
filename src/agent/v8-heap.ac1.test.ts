import { describe, expect, it } from 'vitest';

const SIZE_KEYS = [
  'space_size',
  'space_used_size',
  'space_available_size',
  'physical_space_size',
] as const;

function expectNonNegativeInt(value: unknown, label: string): void {
  expect(typeof value, `${label} is a number`).toBe('number');
  expect(Number.isInteger(value), `${label} is an integer`).toBe(true);
  expect(value as number, `${label} is non-negative`).toBeGreaterThanOrEqual(0);
}

function expectHeapSpaces(value: unknown, label: string): void {
  expect(Array.isArray(value), `${label} is an array`).toBe(true);
  const entries = value as unknown[];
  expect(entries.length, `${label} is non-empty`).toBeGreaterThan(0);
  const names: string[] = [];
  for (const raw of entries) {
    expect(typeof raw, `${label} entry is an object`).toBe('object');
    expect(raw, `${label} entry is not null`).not.toBeNull();
    const entry = raw as Record<string, unknown>;
    expect(typeof entry['name'], `${label} entry has a string name`).toBe('string');
    const name = entry['name'] as string;
    names.push(name);
    for (const key of SIZE_KEYS) {
      expect(entry, `${label} ${name} has ${key}`).toHaveProperty(key);
      expectNonNegativeInt(entry[key], `${label} ${name}.${key}`);
    }
  }
  expect(names, `${label} names`).toContain('new_space');
  expect(names, `${label} names`).toContain('old_space');
}

describe('agent V8 heap spaces — AC-1', () => {
  it('AC-1: sampleHeapSpaces() from the agent entrypoint lists new_space and old_space with non-negative integer sizes', async () => {
    const { sampleHeapSpaces } = await import('./index.js');
    const spaces: unknown = sampleHeapSpaces();
    expectHeapSpaces(spaces, 'sampleHeapSpaces()');
  });

  it("AC-1: the sampler controller's sample carries a heapSpaces part beside eventLoop, memory, gc and backpressure", async () => {
    const { createSamplerController } = await import('./index.js');

    const samples: unknown[] = [];
    let resolveFirst: () => void = () => undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const controller = createSamplerController((sample: unknown) => {
      samples.push(sample);
      resolveFirst();
    });

    controller.start(50);
    try {
      await Promise.race([
        first,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no sample within 2000 ms')), 2000),
        ),
      ]);
    } finally {
      controller.stop();
    }

    expect(samples.length).toBeGreaterThanOrEqual(1);
    const sample = samples[0] as Record<string, unknown>;
    for (const part of ['eventLoop', 'memory', 'gc', 'backpressure', 'heapSpaces']) {
      expect(sample, `sample has a ${part} part`).toHaveProperty(part);
      expect(sample[part], `sample ${part} part is present`).not.toBeUndefined();
    }
    expectHeapSpaces(sample['heapSpaces'], 'sample.heapSpaces');
  });
});
