import { describe, expect, it } from 'vitest';
import { createSamplerController } from './sampler-controller.js';

// Regression test for F-12 (production-readiness audit): a throwing onSample must not become an
// uncaught exception, and the controller keeps ticking. The default reporting path (a process
// warning) is covered in a child process by prototype-patch.integration.test.ts.

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('sampler controller — tick failures (F-12)', () => {
  it('a throwing onSample goes to onError and the next tick still runs', async () => {
    let ticks = 0;
    const errors: unknown[] = [];
    const controller = createSamplerController(
      () => {
        ticks += 1;
        throw new Error(`tick ${ticks} failed`);
      },
      { onError: (error) => errors.push(error) },
    );
    try {
      controller.start(10);
      for (let i = 0; i < 100 && ticks < 3; i += 1) {
        await delay(10);
      }
    } finally {
      controller.stop();
    }
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(errors).toHaveLength(ticks);
    expect((errors[0] as Error).message).toBe('tick 1 failed');
  });

  it('an onError handler that throws is reported as a process warning, and ticking continues', async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    let ticks = 0;
    const controller = createSamplerController(
      () => {
        ticks += 1;
        throw new Error('sample failed');
      },
      {
        onError: () => {
          throw new Error('handler failed');
        },
      },
    );
    try {
      controller.start(10);
      for (let i = 0; i < 100 && ticks < 2; i += 1) {
        await delay(10);
      }
      await delay(0);
    } finally {
      controller.stop();
      process.off('warning', onWarning);
    }
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(warnings.some((w) => w.name === 'ArgusSamplerWarning')).toBe(true);
  });
});
