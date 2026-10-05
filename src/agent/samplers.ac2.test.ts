import { describe, expect, it } from 'vitest';
import type { AgentSample } from './index.js';

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Deliberately block the event loop.
  }
}

describe('agent samplers — AC-2', () => {
  it('AC-2: a ~100 ms block raises one window max to >= 50 ms and the next window max is lower (histogram reset)', async () => {
    const { createSamplerController } = await import('./index.js');

    const intervalMs = 250;
    const samples: AgentSample[] = [];
    let resolveThree: () => void = () => undefined;
    const three = new Promise<void>((resolve) => {
      resolveThree = resolve;
    });

    const controller = createSamplerController((sample: AgentSample) => {
      samples.push(sample);
      if (samples.length === 1) {
        // Block the loop for ~100 ms early inside the second window.
        setTimeout(() => busyWait(100), 20);
      }
      if (samples.length >= 3) resolveThree();
    });

    controller.start(intervalMs);
    try {
      await Promise.race([
        three,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('fewer than 3 samples within 8000 ms')), 8000),
        ),
      ]);
    } finally {
      controller.stop();
    }

    const blocked = samples[1];
    const following = samples[2];
    expect(blocked).toBeDefined();
    expect(following).toBeDefined();
    if (blocked === undefined || following === undefined) return;

    const fiftyMsInNs = 50 * 1_000_000;
    expect(blocked.eventLoop.max).toBeGreaterThanOrEqual(fiftyMsInNs);
    expect(following.eventLoop.max).toBeLessThan(blocked.eventLoop.max);
  }, 15_000);
});
