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

const RULE_SOURCE = `
const findings = [];
for (const w of windows) {
  if (w.eventLoop.max > 100) {
    findings.push({ windowStart: w.start, message: 'event-loop max ' + w.eventLoop.max });
  }
}
return findings;
`;

let runner: PluginRunnerUnderTest | undefined;

afterAll(async () => {
  await runner?.close();
});

describe('plugin runner sandbox — AC-1', () => {
  it('AC-1: a rule run against three windows returns exactly one JSON-serializable finding for the second window', async () => {
    const mod = (await import('./index.js')) as unknown as PluginRunnerModule;
    runner = mod.createPluginRunner();

    const windows = [windowAt(1_000, 50), windowAt(2_000, 500), windowAt(3_000, 50)];
    const result = await runner.run(RULE_SOURCE, windows);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
    }
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.windowStart).toBe(2_000);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  }, 20_000);
});
