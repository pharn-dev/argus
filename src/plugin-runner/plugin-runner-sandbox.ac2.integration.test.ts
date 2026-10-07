import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';
import type { AggregatedWindow } from '../collector/index.js';

type RuleFindingUnderTest = { windowStart: number; message: string };

type RuleRunResultUnderTest =
  | { ok: true; findings: RuleFindingUnderTest[] }
  | { ok: false; error: { code: string; message: string } };

type PluginRunnerUnderTest = {
  run(source: string, windows: readonly AggregatedWindow[]): Promise<RuleRunResultUnderTest>;
  close(): Promise<void>;
};

type PluginRunnerModule = {
  createPluginRunner: (options?: {
    timeoutMs?: number;
    memoryLimitMb?: number;
    isolatedVmModule?: string;
  }) => PluginRunnerUnderTest;
  RuleErrorCode: {
    RULE_THREW: string;
    TIMEOUT: string;
    MEMORY_LIMIT: string;
    COMPILE_ERROR: string;
  };
};

/** A full AggregatedWindow at the given start with the given event-loop max. */
function windowAt(start: number, eventLoopMax: number): AggregatedWindow {
  return {
    start,
    end: start + 1000,
    count: 10,
    late: 0,
    eventLoop: { max: eventLoopMax, p99: eventLoopMax, mean: 10 },
    memory: { heapUsedLast: 1000, heapUsedMax: 2000, rssLast: 3000, rssMax: 4000 },
    gc: { count: 1, totalPause: 5, maxPause: 5 },
    backpressure: { events: 0, totalStall: 0, maxStall: 0 },
  };
}

const AC1_RULE_SOURCE = `
const findings = [];
for (const w of windows) {
  if (w.eventLoop.max > 100) {
    findings.push({ windowStart: w.start, message: 'event-loop max ' + w.eventLoop.max });
  }
}
return findings;
`;

const THROWING_RULE = `throw new Error('boom');`;
const INFINITE_LOOP_RULE = `while (true) {}`;
const ALLOCATING_RULE = `
const hoard = [];
while (true) {
  hoard.push(new Array(1000000).fill(hoard.length));
}
`;
const INVALID_RULE = `return [ {{ this is not ) valid javascript`;

/** Narrow a result to its failure branch, failing the test with the findings otherwise. */
function failureOf(result: RuleRunResultUnderTest): { code: string; message: string } {
  if (result.ok) {
    throw new Error(`expected a failure result, got success: ${JSON.stringify(result.findings)}`);
  }
  return result.error;
}

let runner: PluginRunnerUnderTest | undefined;
let interval: ReturnType<typeof setInterval> | undefined;

afterAll(async () => {
  if (interval !== undefined) {
    clearInterval(interval);
  }
  await runner?.close();
});

describe('plugin runner sandbox — AC-2', () => {
  it('AC-2: throwing, looping, allocating and invalid rules each resolve a typed failure without blocking the host, and the runner still works afterwards', async () => {
    const mod = (await import('./index.js')) as unknown as PluginRunnerModule;
    const codes = mod.RuleErrorCode;
    expect(typeof codes.RULE_THREW).toBe('string');
    expect(typeof codes.TIMEOUT).toBe('string');
    expect(typeof codes.MEMORY_LIMIT).toBe('string');
    expect(typeof codes.COMPILE_ERROR).toBe('string');
    expect(
      new Set([codes.RULE_THREW, codes.TIMEOUT, codes.MEMORY_LIMIT, codes.COMPILE_ERROR]).size,
    ).toBe(4);

    runner = mod.createPluginRunner({ timeoutMs: 200, memoryLimitMb: 16 });

    let ticks = 0;
    interval = setInterval(() => {
      ticks += 1;
    }, 10);

    const windows = [windowAt(1_000, 50), windowAt(2_000, 500), windowAt(3_000, 50)];

    // 1. A rule that throws.
    const threw = failureOf(await runner.run(THROWING_RULE, windows));
    expect(threw.code).toBe(codes.RULE_THREW);
    expect(threw.message).toContain('boom');

    // 2. An infinite loop: resolves within 2000ms while the host interval keeps ticking.
    const ticksBefore = ticks;
    const loopStarted = performance.now();
    const looped = failureOf(await runner.run(INFINITE_LOOP_RULE, windows));
    const loopElapsed = performance.now() - loopStarted;
    const ticksDuring = ticks - ticksBefore;
    expect(looped.code).toBe(codes.TIMEOUT);
    expect(loopElapsed).toBeLessThan(2000);
    expect(ticksDuring).toBeGreaterThanOrEqual(5);

    // 3. A rule that allocates until memory runs out.
    const exhausted = failureOf(await runner.run(ALLOCATING_RULE, windows));
    expect(exhausted.code).toBe(codes.MEMORY_LIMIT);

    // 4. A rule whose source is not valid JavaScript.
    const invalid = failureOf(await runner.run(INVALID_RULE, windows));
    expect(invalid.code).toBe(codes.COMPILE_ERROR);

    // 5. The AC-1 rule still succeeds on the same runner.
    const recovered = await runner.run(AC1_RULE_SOURCE, windows);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.findings).toHaveLength(1);
      expect(recovered.findings[0]?.windowStart).toBe(2_000);
    }
  }, 30_000);
});
