import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

type RulesDirectoryResultUnderTest =
  | {
      ok: true;
      rules: RuleDescriptorUnderTest[];
      failures: { id: string; error: { code: string; message: string } }[];
    }
  | { ok: false; error: { code: string; message: string } };

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
  loadRulesDirectory: (dir: string) => Promise<RulesDirectoryResultUnderTest>;
  eventLoopLagRule: (params?: {
    thresholdNs?: number;
    windows?: number;
  }) => RuleDescriptorUnderTest;
  heapGrowthRule: (params?: { windows?: number }) => RuleDescriptorUnderTest;
  gcPauseShareRule: (params?: { thresholdPerMille?: number }) => RuleDescriptorUnderTest;
  RuleErrorCode: { RULE_THREW: string; COMPILE_ERROR: string };
};

const LAG_ID = 'argus/event-loop-lag';
const HEAP_ID = 'argus/heap-growth';
const GC_ID = 'argus/gc-pause-share';

/** Set on the HOST's globalThis only if a user rule file is ever evaluated in this process. */
const HOST_MARKER = '__argusRuleLibraryAc3HostMarker';

function markerLine(name: string): string {
  return `try { globalThis.${HOST_MARKER} = ${JSON.stringify(name)}; } catch (_ignored) { /* frozen global */ }\n`;
}

const GOOD_RULE = `${markerLine('good')}return [{ windowStart: windows[0].start, message: 'good user rule fired' }];\n`;
const THROWING_RULE = `${markerLine('throws')}throw new Error('user rule boom');\n`;
const BROKEN_RULE = `${markerLine('broken')}return [ this is not valid javascript ;\n`;
const NOTES_TEXT = `${markerLine('notes')}return [{ windowStart: 1, message: 'a .txt file must never load' }];\n`;

/** The AC-1 windows: 1 s apart, end = start + 1000. */
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

const LOW_LAG = 10_000_000;
const HIGH_LAG = 200_000_000;
const LOW_GC = 5_000_000;
const HIGH_GC = 300_000_000;
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
const AC1_WINDOWS: AggregatedWindow[] = LAG.map((lag, i) =>
  windowAt(i, lag, HEAP[i] ?? 0, GC[i] ?? 0),
);

function startOf(index: number): number {
  return 1000 * (index + 1);
}

function successOf(result: RuleRunResultUnderTest | undefined): RuleFindingUnderTest[] {
  expect(result).toBeDefined();
  if (result === undefined || !result.ok) {
    const detail =
      result === undefined ? 'no result' : `${result.error.code}: ${result.error.message}`;
    throw new Error(`expected a success result, got ${detail}`);
  }
  return result.findings;
}

function errorCodeOf(result: RuleRunResultUnderTest | undefined): string {
  expect(result).toBeDefined();
  if (result === undefined || result.ok) {
    throw new Error(`expected a failure result, got ${JSON.stringify(result)}`);
  }
  return result.error.code;
}

function startsOf(findings: RuleFindingUnderTest[]): number[] {
  return findings.map((finding) => finding.windowStart).sort((a, b) => a - b);
}

let runner: PluginRunnerUnderTest | undefined;
let rulesDir: string | undefined;

afterAll(async () => {
  await runner?.close();
  if (rulesDir !== undefined) {
    await rm(rulesDir, { recursive: true, force: true });
  }
});

describe('plugin-runner rule library — AC-3', () => {
  it('AC-3: user rules loaded from a directory run alongside the built-ins, each failure stays its own typed result, and no user file runs in the host', async () => {
    Reflect.deleteProperty(globalThis, HOST_MARKER);
    rulesDir = await mkdtemp(join(tmpdir(), 'argus-rule-library-ac3-'));
    await writeFile(join(rulesDir, 'good.js'), GOOD_RULE, 'utf8');
    await writeFile(join(rulesDir, 'throws.js'), THROWING_RULE, 'utf8');
    await writeFile(join(rulesDir, 'broken.js'), BROKEN_RULE, 'utf8');
    await writeFile(join(rulesDir, 'notes.txt'), NOTES_TEXT, 'utf8');

    const mod = (await import('./index.js')) as unknown as RuleLibraryModule;

    const loaded = await mod.loadRulesDirectory(rulesDir);
    if (!loaded.ok) {
      throw new Error(
        `expected the directory to load, got ${loaded.error.code}: ${loaded.error.message}`,
      );
    }
    expect(loaded.rules).toHaveLength(3);
    expect(loaded.rules.map((rule) => rule.id).sort()).toEqual(['broken', 'good', 'throws']);
    expect(loaded.failures).toEqual([]);

    runner = mod.createPluginRunner();
    const builtins = [mod.eventLoopLagRule(), mod.heapGrowthRule(), mod.gcPauseShareRule()];
    const results = await mod.runRules(runner, [...builtins, ...loaded.rules], AC1_WINDOWS);

    expect(Object.keys(results).sort()).toEqual(
      [LAG_ID, HEAP_ID, GC_ID, 'broken', 'good', 'throws'].sort(),
    );

    const good = successOf(results['good']);
    expect(good).toHaveLength(1);
    expect(good[0]?.windowStart).toBe(startOf(0));
    expect(good[0]?.message).toBe('good user rule fired');

    expect(errorCodeOf(results['throws'])).toBe(mod.RuleErrorCode.RULE_THREW);
    expect(errorCodeOf(results['broken'])).toBe(mod.RuleErrorCode.COMPILE_ERROR);

    expect(startsOf(successOf(results[LAG_ID]))).toEqual([startOf(1), startOf(2), startOf(3)]);
    expect(startsOf(successOf(results[HEAP_ID]))).toEqual([startOf(5), startOf(6), startOf(7)]);
    expect(startsOf(successOf(results[GC_ID]))).toEqual([startOf(10)]);

    expect(Reflect.has(globalThis, HOST_MARKER)).toBe(false);
  }, 30_000);
});
