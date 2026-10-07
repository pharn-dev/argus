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
  RuleErrorCode: { ISOLATED_VM_MISSING: string };
};

/** A specifier no installed package resolves to: the sandbox child cannot load it. */
const MISSING_MODULE = 'argus-test-isolated-vm-that-does-not-exist';

const RULE_SOURCE = `return [];`;

const WINDOW: AggregatedWindow = {
  start: 1_000,
  end: 2_000,
  count: 10,
  late: 0,
  eventLoop: { max: 50, p99: 50, mean: 10 },
  memory: { heapUsedLast: 1000, heapUsedMax: 2000, rssLast: 3000, rssMax: 4000 },
  gc: { count: 1, totalPause: 5, maxPause: 5 },
  backpressure: { events: 0, totalStall: 0, maxStall: 0 },
};

let runner: PluginRunnerUnderTest | undefined;

afterAll(async () => {
  await runner?.close();
});

describe('plugin runner sandbox — AC-3', () => {
  it('AC-3: a sandbox that cannot load isolated-vm resolves a typed failure naming how to install it, and the host keeps running', async () => {
    const mod = (await import('./index.js')) as unknown as PluginRunnerModule;
    const missingCode = mod.RuleErrorCode.ISOLATED_VM_MISSING;
    expect(typeof missingCode).toBe('string');

    runner = mod.createPluginRunner({ isolatedVmModule: MISSING_MODULE });

    const settled = await runner.run(RULE_SOURCE, [WINDOW]).then(
      (result) => ({ resolved: true as const, result }),
      (error: unknown) => ({ resolved: false as const, error }),
    );

    expect(settled.resolved).toBe(true);
    if (!settled.resolved) {
      return;
    }
    const { result } = settled;
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe(missingCode);
    expect(result.error.message).toContain('isolated-vm');
    expect(result.error.message).toContain('npm install isolated-vm');

    // The host process is still running: this assertion executes, and nothing set an exit code.
    expect(process.exitCode).toBeUndefined();

    await expect(runner.close()).resolves.toBeUndefined();
  }, 20_000);
});
