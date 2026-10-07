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

type RuleDescriptorUnderTest = { readonly id: string; readonly source: string };

type RuleLibraryModule = {
  createPluginRunner: (options?: {
    timeoutMs?: number;
    memoryLimitMb?: number;
  }) => PluginRunnerUnderTest;
  runRules: (
    runner: PluginRunnerUnderTest,
    rules: readonly RuleDescriptorUnderTest[],
    windows: readonly AggregatedWindow[],
  ) => Promise<Record<string, RuleRunResultUnderTest>>;
  eventLoopLagRule: (params?: {
    thresholdNs?: number;
    windows?: number;
  }) => RuleDescriptorUnderTest;
  heapGrowthRule: (params?: { windows?: number }) => RuleDescriptorUnderTest;
  gcPauseShareRule: (params?: { thresholdPerMille?: number }) => RuleDescriptorUnderTest;
  BuiltinRuleId: { EVENT_LOOP_LAG: string; HEAP_GROWTH: string; GC_PAUSE_SHARE: string };
};

const LAG_ID = 'argus/event-loop-lag';
const HEAP_ID = 'argus/heap-growth';
const GC_ID = 'argus/gc-pause-share';

/** 1 s windows: start = 1000 * (index + 1), end = start + 1000. */
function windowAt(
  index: number,
  eventLoopMax: number,
  heapUsedLast: number,
  gcTotalPause: number,
): AggregatedWindow {
  const start = 1000 * (index + 1);
  return {
    start,
    end: start + 1000,
    count: 10,
    late: 0,
    eventLoop: { max: eventLoopMax, p99: eventLoopMax, mean: 1_000_000 },
    memory: { heapUsedLast, heapUsedMax: heapUsedLast, rssLast: 500_000_000, rssMax: 500_000_000 },
    gc: { count: 1, totalPause: gcTotalPause, maxPause: gcTotalPause },
    backpressure: { events: 0, totalStall: 0, maxStall: 0 },
  };
}

const LOW_LAG = 10_000_000; // 10 ms, below the 100 ms default
const HIGH_LAG = 200_000_000; // 200 ms, above the 100 ms default
const LOW_GC = 5_000_000; // 5 ms of a 1000 ms window = 5 per-mille
const HIGH_GC = 300_000_000; // 300 ms of a 1000 ms window = 300 per-mille

/**
 * Windows holding every pattern once:
 * - event-loop max above 100 ms for windows 1..3 (a run of 3), plus an isolated high window 8 (a run of 1);
 * - heap used strictly rising across windows 5..7 only (60M < 70M < 80M), flat or falling elsewhere;
 * - GC total pause above 10 % of the window in window 10 only.
 */
const LAG = [
  LOW_LAG,
  HIGH_LAG,
  HIGH_LAG,
  HIGH_LAG,
  LOW_LAG,
  LOW_LAG,
  LOW_LAG,
  LOW_LAG,
  HIGH_LAG,
  LOW_LAG,
  LOW_LAG,
  LOW_LAG,
];
const HEAP = [
  100_000_000, 100_000_000, 100_000_000, 100_000_000, 100_000_000, 60_000_000, 70_000_000,
  80_000_000, 40_000_000, 40_000_000, 40_000_000, 40_000_000,
];
const GC = [
  LOW_GC,
  LOW_GC,
  LOW_GC,
  LOW_GC,
  LOW_GC,
  LOW_GC,
  LOW_GC,
  LOW_GC,
  LOW_GC,
  LOW_GC,
  HIGH_GC,
  LOW_GC,
];

const PATTERN_WINDOWS: AggregatedWindow[] = LAG.map((lag, i) =>
  windowAt(i, lag, HEAP[i] ?? 0, GC[i] ?? 0),
);

/** Low lag, flat heap, low GC: matches none of the patterns. */
const QUIET_WINDOWS: AggregatedWindow[] = Array.from({ length: 8 }, (_unused, i) =>
  windowAt(i, LOW_LAG, 100_000_000, LOW_GC),
);

function startOf(index: number): number {
  return 1000 * (index + 1);
}

function findingStarts(result: RuleRunResultUnderTest | undefined): number[] {
  expect(result).toBeDefined();
  if (result === undefined || !result.ok) {
    const detail =
      result === undefined ? 'no result' : `${result.error.code}: ${result.error.message}`;
    throw new Error(`expected a success result, got ${detail}`);
  }
  for (const finding of result.findings) {
    expect(typeof finding.message).toBe('string');
  }
  return result.findings.map((finding) => finding.windowStart).sort((a, b) => a - b);
}

let runner: PluginRunnerUnderTest | undefined;

afterAll(async () => {
  await runner?.close();
});

describe('plugin-runner rule library — AC-1', () => {
  it('AC-1: the three built-in rules with default parameters flag exactly the covered windows, and match nothing in quiet windows', async () => {
    const mod = (await import('./index.js')) as unknown as RuleLibraryModule;
    expect(mod.BuiltinRuleId.EVENT_LOOP_LAG).toBe(LAG_ID);
    expect(mod.BuiltinRuleId.HEAP_GROWTH).toBe(HEAP_ID);
    expect(mod.BuiltinRuleId.GC_PAUSE_SHARE).toBe(GC_ID);

    runner ??= mod.createPluginRunner();
    const rules = [mod.eventLoopLagRule(), mod.heapGrowthRule(), mod.gcPauseShareRule()];
    expect(rules.map((rule) => rule.id)).toEqual([LAG_ID, HEAP_ID, GC_ID]);

    const results = await mod.runRules(runner, rules, PATTERN_WINDOWS);
    expect(Object.keys(results).sort()).toEqual([LAG_ID, HEAP_ID, GC_ID].sort());
    expect(findingStarts(results[LAG_ID])).toEqual([startOf(1), startOf(2), startOf(3)]);
    expect(findingStarts(results[HEAP_ID])).toEqual([startOf(5), startOf(6), startOf(7)]);
    expect(findingStarts(results[GC_ID])).toEqual([startOf(10)]);

    const quiet = await mod.runRules(runner, rules, QUIET_WINDOWS);
    expect(Object.keys(quiet).sort()).toEqual([LAG_ID, HEAP_ID, GC_ID].sort());
    for (const id of [LAG_ID, HEAP_ID, GC_ID]) {
      expect(quiet[id]).toEqual({ ok: true, findings: [] });
    }
  }, 30_000);

  it('AC-1: explicitly given parameters reach the built-in rules and change which windows they cover', async () => {
    const mod = (await import('./index.js')) as unknown as RuleLibraryModule;
    runner ??= mod.createPluginRunner();

    const rules = [
      // Every window above 150 ms counts, even a run of one.
      mod.eventLoopLagRule({ thresholdNs: 150_000_000, windows: 1 }),
      // The rising run is 3 windows long, so requiring 4 matches nothing.
      mod.heapGrowthRule({ windows: 4 }),
      // 300 per-mille is not above 400 per-mille.
      mod.gcPauseShareRule({ thresholdPerMille: 400 }),
    ];
    const results = await mod.runRules(runner, rules, PATTERN_WINDOWS);

    expect(Object.keys(results).sort()).toEqual([LAG_ID, HEAP_ID, GC_ID].sort());
    expect(findingStarts(results[LAG_ID])).toEqual([
      startOf(1),
      startOf(2),
      startOf(3),
      startOf(8),
    ]);
    expect(results[HEAP_ID]).toEqual({ ok: true, findings: [] });
    expect(results[GC_ID]).toEqual({ ok: true, findings: [] });
  }, 30_000);
});
