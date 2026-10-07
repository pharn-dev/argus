import { describe, expect, it } from 'vitest';
import type { AggregatedWindow } from '../collector/index.js';

type RuleRunResultUnderTest =
  | { ok: true; findings: { windowStart: number; message: string }[] }
  | { ok: false; error: { code: string; message: string } };

type PluginRunnerUnderTest = {
  run(source: string, windows: readonly AggregatedWindow[]): Promise<RuleRunResultUnderTest>;
  close(): Promise<void>;
};

type RuleDescriptorUnderTest = { readonly id: string; readonly source: string };

// The factories are called with deliberately invalid values, so their params are typed as unknown here.
type RuleLibraryModule = {
  runRules: (
    runner: PluginRunnerUnderTest,
    rules: readonly RuleDescriptorUnderTest[],
    windows: readonly AggregatedWindow[],
  ) => Promise<Record<string, RuleRunResultUnderTest>>;
  eventLoopLagRule: (params?: unknown) => RuleDescriptorUnderTest;
  heapGrowthRule: (params?: unknown) => RuleDescriptorUnderTest;
  gcPauseShareRule: (params?: unknown) => RuleDescriptorUnderTest;
  BuiltinRuleId: { EVENT_LOOP_LAG: string; HEAP_GROWTH: string; GC_PAUSE_SHARE: string };
  RuleParameterError: new (...args: never[]) => Error;
  RuleErrorCode: { INVALID_PARAMETER: string };
};

type ParameterErrorUnderTest = Error & { code?: unknown; ruleId?: unknown; parameter?: unknown };

const WINDOW: AggregatedWindow = {
  start: 1_000,
  end: 2_000,
  count: 10,
  late: 0,
  eventLoop: { max: 200_000_000, p99: 200_000_000, mean: 1_000_000 },
  memory: { heapUsedLast: 1000, heapUsedMax: 2000, rssLast: 3000, rssMax: 4000 },
  gc: { count: 1, totalPause: 300_000_000, maxPause: 300_000_000 },
  backpressure: { events: 0, totalStall: 0, maxStall: 0 },
};

/** Calls `configure` and returns what it threw synchronously; fails the test if it returned instead. */
function thrownBy(configure: () => unknown): unknown {
  let returned: unknown;
  try {
    returned = configure();
  } catch (error) {
    return error;
  }
  throw new Error(`expected a synchronous throw, but configuration returned ${String(returned)}`);
}

describe('plugin-runner rule library — AC-2', () => {
  it('AC-2: an invalid built-in rule parameter throws a typed invalid-parameter error naming the rule id and the parameter, and no sandbox run starts', async () => {
    const mod = (await import('./index.js')) as unknown as RuleLibraryModule;
    expect(mod.RuleErrorCode.INVALID_PARAMETER).toBe('ARGUS_RULE_INVALID_PARAMETER');

    const cases: {
      label: string;
      configure: () => RuleDescriptorUnderTest;
      ruleId: string;
      parameter: string;
    }[] = [
      {
        label: 'negative threshold',
        configure: () => mod.eventLoopLagRule({ thresholdNs: -1 }),
        ruleId: 'argus/event-loop-lag',
        parameter: 'thresholdNs',
      },
      {
        label: 'zero window count',
        configure: () => mod.eventLoopLagRule({ windows: 0 }),
        ruleId: 'argus/event-loop-lag',
        parameter: 'windows',
      },
      {
        label: 'non-integer window count',
        configure: () => mod.heapGrowthRule({ windows: 2.5 }),
        ruleId: 'argus/heap-growth',
        parameter: 'windows',
      },
      {
        label: 'wrong type',
        configure: () => mod.gcPauseShareRule({ thresholdPerMille: '100' }),
        ruleId: 'argus/gc-pause-share',
        parameter: 'thresholdPerMille',
      },
    ];

    expect(mod.BuiltinRuleId.EVENT_LOOP_LAG).toBe('argus/event-loop-lag');
    expect(mod.BuiltinRuleId.HEAP_GROWTH).toBe('argus/heap-growth');
    expect(mod.BuiltinRuleId.GC_PAUSE_SHARE).toBe('argus/gc-pause-share');

    const produced: RuleDescriptorUnderTest[] = [];
    for (const testCase of cases) {
      const error = thrownBy(() => {
        const descriptor = testCase.configure();
        produced.push(descriptor);
        return descriptor;
      });
      expect(error, testCase.label).toBeInstanceOf(mod.RuleParameterError);
      const typed = error as ParameterErrorUnderTest;
      expect(typed.code, testCase.label).toBe('ARGUS_RULE_INVALID_PARAMETER');
      expect(typed.code, testCase.label).toBe(mod.RuleErrorCode.INVALID_PARAMETER);
      expect(typed.ruleId, testCase.label).toBe(testCase.ruleId);
      expect(typed.parameter, testCase.label).toBe(testCase.parameter);
      expect(typed.message, testCase.label).toContain(testCase.ruleId);
      expect(typed.message, testCase.label).toContain(testCase.parameter);
    }
    expect(produced).toHaveLength(0);

    // A spy runner: no descriptor was produced, so handing what we have to runRules starts no sandbox run.
    let runCalls = 0;
    const spyRunner: PluginRunnerUnderTest = {
      run: () => {
        runCalls += 1;
        return Promise.resolve({ ok: true, findings: [] });
      },
      close: () => Promise.resolve(),
    };
    const results = await mod.runRules(spyRunner, produced, [WINDOW]);
    expect(runCalls).toBe(0);
    expect(results).toEqual({});
  });
});
