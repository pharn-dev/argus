import { describe, expect, it } from 'vitest';
import type { AgentSample } from './index.js';

function expectNonNegativeInt(value: unknown): void {
  expect(typeof value).toBe('number');
  expect(Number.isInteger(value)).toBe(true);
  expect(value as number).toBeGreaterThanOrEqual(0);
}

describe('agent samplers — AC-1', () => {
  it('AC-1: the controller from the agent entrypoint emits one integer sample per interval', async () => {
    const { createSamplerController } = await import('./index.js');

    const samples: AgentSample[] = [];
    let resolveFirst: () => void = () => undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const controller = createSamplerController((sample: AgentSample) => {
      samples.push(sample);
      resolveFirst();
    });

    const intervalMs = 50;
    controller.start(intervalMs);
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
    const sample = samples[0];
    expect(sample).toBeDefined();
    if (sample === undefined) return;

    // Timestamp: an integer number of milliseconds, plausibly "now".
    expectNonNegativeInt(sample.timestamp);
    expect(Math.abs(Date.now() - sample.timestamp)).toBeLessThan(10_000);

    // Event loop part: integer, non-negative nanoseconds.
    for (const key of ['min', 'max', 'mean', 'p50', 'p99'] as const) {
      expect(sample.eventLoop).toHaveProperty(key);
      expectNonNegativeInt(sample.eventLoop[key]);
    }

    // Memory part: integer, non-negative bytes.
    for (const key of ['heapUsed', 'heapTotal', 'rss', 'external', 'arrayBuffers'] as const) {
      expect(sample.memory).toHaveProperty(key);
      expectNonNegativeInt(sample.memory[key]);
    }
    expect(sample.memory.rss).toBeGreaterThan(0);
    expect(sample.memory.heapUsed).toBeGreaterThan(0);
  });
});
