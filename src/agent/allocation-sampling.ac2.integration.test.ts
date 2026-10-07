import { describe, expect, it } from 'vitest';

describe('agent allocation sampling — AC-2', () => {
  it('AC-2: a second same-tick sampleAllocations call rejects as already in progress, and a later call resolves', async () => {
    const { sampleAllocations } = await import('./index.js');
    const call = sampleAllocations as (options?: unknown) => Promise<unknown>;

    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    expect(() => {
      first = call({ durationMs: 100 });
      second = call({ durationMs: 100 });
    }, 'neither same-tick call throws synchronously').not.toThrow();

    expect(first, 'the first call returns a promise').toBeInstanceOf(Promise);
    expect(second, 'the second call returns a promise').toBeInstanceOf(Promise);

    const [firstOutcome, secondOutcome] = await Promise.allSettled([
      first as Promise<unknown>,
      second as Promise<unknown>,
    ]);

    expect(firstOutcome.status, 'the first call resolves').toBe('fulfilled');
    if (firstOutcome.status === 'fulfilled') {
      expect(
        Array.isArray(firstOutcome.value),
        'the first call resolves with an array of sites',
      ).toBe(true);
    }

    expect(secondOutcome.status, 'the second call rejects').toBe('rejected');
    if (secondOutcome.status === 'rejected') {
      const reason: unknown = secondOutcome.reason;
      expect(reason, 'the second call rejects with an Error').toBeInstanceOf(Error);
      expect(
        (reason as Error).message,
        'the rejection says a session is already in progress',
      ).toContain('already in progress');
    }

    const third: unknown = await call({ durationMs: 100 });
    expect(Array.isArray(third), 'a call after both settled resolves with an array of sites').toBe(
      true,
    );
  }, 30_000);
});
