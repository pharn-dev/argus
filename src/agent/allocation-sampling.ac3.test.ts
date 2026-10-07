import { describe, expect, it } from 'vitest';

type SampleCall = (options?: unknown) => Promise<unknown>;

async function expectRejectionNaming(
  call: SampleCall,
  options: Record<string, unknown>,
  optionName: string,
): Promise<void> {
  const label = `${optionName}: ${String(options[optionName])} (${typeof options[optionName]})`;
  let pending: Promise<unknown> | undefined;
  expect(() => {
    pending = call(options);
  }, `${label} does not throw synchronously`).not.toThrow();
  expect(pending, `${label} returns a promise`).toBeInstanceOf(Promise);

  const [outcome] = await Promise.allSettled([pending as Promise<unknown>]);
  expect(outcome.status, `${label} rejects`).toBe('rejected');
  if (outcome.status === 'rejected') {
    const reason: unknown = outcome.reason;
    expect(reason, `${label} rejects with an Error`).toBeInstanceOf(Error);
    expect((reason as Error).message, `${label} rejection names the invalid option`).toContain(
      optionName,
    );
  }
}

describe('agent allocation sampling — AC-3', () => {
  it('AC-3: invalid samplingInterval or durationMs rejects with an Error naming the option, and a later valid call resolves', async () => {
    const { sampleAllocations } = await import('./index.js');
    const call = sampleAllocations as SampleCall;

    for (const samplingInterval of [0, -1, 1.5, Number.NaN, '1024']) {
      await expectRejectionNaming(call, { samplingInterval, durationMs: 50 }, 'samplingInterval');
    }

    for (const durationMs of [0, -5, 2.5, '100']) {
      await expectRejectionNaming(call, { durationMs }, 'durationMs');
    }

    const valid: unknown = await call({ durationMs: 50 });
    expect(Array.isArray(valid), 'a valid call afterwards resolves with an array of sites').toBe(
      true,
    );
  }, 30_000);
});
