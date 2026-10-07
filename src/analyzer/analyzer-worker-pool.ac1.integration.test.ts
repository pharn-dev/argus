import { describe, expect, it } from 'vitest';

type WorkerPoolUnderTest = {
  readonly size: number;
  readonly closed: boolean;
  run<T = unknown>(payload: unknown, options?: { timeoutMs?: number }): Promise<T>;
  close(): Promise<void>;
};

type PoolModule = {
  createWorkerPool: (options: {
    size: number;
    workerFile: string | URL;
    maxQueue?: number;
    taskTimeoutMs?: number;
  }) => WorkerPoolUnderTest;
};

function errorCode(reason: unknown): unknown {
  return typeof reason === 'object' && reason !== null
    ? (reason as { code?: unknown }).code
    : undefined;
}

describe('analyzer worker pool', () => {
  it('AC-1: echoes, rejects a crash and a timeout, replaces the worker, and rejects queued tasks on close', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const mod = (await import('./index.js')) as unknown as PoolModule;
      const workerFile = new URL('./workers/test-task.worker.ts', import.meta.url);
      const pool = mod.createWorkerPool({ size: 1, workerFile });
      expect(pool.size).toBe(1);
      expect(pool.closed).toBe(false);

      // 1. echo resolves with its input
      const firstPayload = { kind: 'echo', value: 'first', n: 1 };
      await expect(pool.run(firstPayload)).resolves.toEqual(firstPayload);

      // 2. crash rejects with an Error
      const crash = await pool.run({ kind: 'crash' }).then(
        () => ({ ok: true as const, reason: undefined }),
        (reason: unknown) => ({ ok: false as const, reason }),
      );
      expect(crash.ok).toBe(false);
      expect(crash.reason).toBeInstanceOf(Error);
      expect(errorCode(crash.reason)).toBe('ERR_WORKER_CRASHED');

      // 3. hang rejects with a timeout error
      const startedAt = Date.now();
      const hang = await pool.run({ kind: 'hang' }, { timeoutMs: 300 }).then(
        () => ({ ok: true as const, reason: undefined }),
        (reason: unknown) => ({ ok: false as const, reason }),
      );
      expect(hang.ok).toBe(false);
      expect(hang.reason).toBeInstanceOf(Error);
      expect(errorCode(hang.reason)).toBe('ERR_WORKER_TASK_TIMEOUT');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);

      // 4. the worker was replaced: a following echo resolves
      const secondPayload = { kind: 'echo', value: 'second', list: [1, 2, 3] };
      await expect(pool.run(secondPayload)).resolves.toEqual(secondPayload);

      // 5. a hang occupies the only worker, two tasks queue behind it, then close()
      const inFlight = pool.run({ kind: 'hang' }, { timeoutMs: 60_000 });
      const queuedA = pool.run({ kind: 'echo', value: 'queued-a' });
      const queuedB = pool.run({ kind: 'echo', value: 'queued-b' });
      const settledAll = Promise.allSettled([inFlight, queuedA, queuedB]);

      await pool.close();
      expect(pool.closed).toBe(true);

      const [, settledA, settledB] = await settledAll;
      expect(settledA?.status).toBe('rejected');
      expect(settledB?.status).toBe('rejected');
      const reasonA = settledA?.status === 'rejected' ? (settledA.reason as unknown) : undefined;
      const reasonB = settledB?.status === 'rejected' ? (settledB.reason as unknown) : undefined;
      expect(reasonA).toBeInstanceOf(Error);
      expect(reasonB).toBeInstanceOf(Error);
      expect(errorCode(reasonA)).toBe('ERR_WORKER_POOL_CLOSED');
      expect(errorCode(reasonB)).toBe('ERR_WORKER_POOL_CLOSED');

      // give any stray rejection a chance to surface
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 30_000);
});
