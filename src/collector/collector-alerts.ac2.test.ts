import { describe, expect, it } from 'vitest';

type AlertRuleInput = {
  id: string;
  metric: string;
  comparison: string;
  threshold: number;
  forWindows?: number;
};

type AlertsModule = {
  createAlertEvaluator: (rules: readonly AlertRuleInput[]) => unknown;
  createCollector: (options: {
    windowMs: number;
    capacity: number;
    alerts?: readonly AlertRuleInput[];
  }) => unknown;
};

const valid: AlertRuleInput = {
  id: 'ok-rule',
  metric: 'eventLoop.p99',
  comparison: '>',
  threshold: 100,
};

/** Each case: a rule set holding exactly one invalid rule, and the id that rule carries. */
const invalidCases: Array<{ name: string; offendingId: string; rules: AlertRuleInput[] }> = [
  {
    name: 'unknown metric path',
    offendingId: 'bad-metric',
    rules: [valid, { id: 'bad-metric', metric: 'eventLoop.nope', comparison: '>', threshold: 1 }],
  },
  {
    name: 'threshold 1.5',
    offendingId: 'bad-float',
    rules: [valid, { id: 'bad-float', metric: 'gc.maxPause', comparison: '>', threshold: 1.5 }],
  },
  {
    name: 'threshold -1',
    offendingId: 'bad-negative',
    rules: [valid, { id: 'bad-negative', metric: 'gc.maxPause', comparison: '>=', threshold: -1 }],
  },
  {
    name: 'comparison <',
    offendingId: 'bad-comparison',
    rules: [valid, { id: 'bad-comparison', metric: 'gc.maxPause', comparison: '<', threshold: 10 }],
  },
  {
    name: 'forWindows 0',
    offendingId: 'bad-for',
    rules: [
      valid,
      {
        id: 'bad-for',
        metric: 'memory.heapUsedMax',
        comparison: '>',
        threshold: 10,
        forWindows: 0,
      },
    ],
  },
  {
    name: 'duplicate rule id',
    offendingId: 'dup-id',
    rules: [
      valid,
      { id: 'dup-id', metric: 'gc.count', comparison: '>', threshold: 1 },
      { id: 'dup-id', metric: 'gc.totalPause', comparison: '>', threshold: 1 },
    ],
  },
];

/** Call `create` and return the error it threw synchronously, or undefined if it did not throw. */
function thrownBy(create: () => unknown): unknown {
  let result: unknown;
  try {
    result = create();
  } catch (error) {
    return error;
  }
  void result;
  return undefined;
}

describe('collector alerts — AC-2', () => {
  it('AC-2: creating an evaluator or a collector with one invalid rule throws synchronously naming that rule id', async () => {
    const alertsModule = (await import('./index.js')) as unknown as AlertsModule;

    for (const testCase of invalidCases) {
      const creators: Array<[string, () => unknown]> = [
        ['createAlertEvaluator', () => alertsModule.createAlertEvaluator(testCase.rules)],
        [
          'createCollector',
          () =>
            alertsModule.createCollector({ windowMs: 1000, capacity: 10, alerts: testCase.rules }),
        ],
      ];
      for (const [creatorName, create] of creators) {
        expect(typeof (alertsModule as Record<string, unknown>)[creatorName]).toBe('function');
        const error = thrownBy(create);
        expect(error, `${creatorName} with ${testCase.name} must throw`).toBeInstanceOf(Error);
        expect(
          (error as Error).message,
          `${creatorName} with ${testCase.name} must name the rule id`,
        ).toContain(testCase.offendingId);
      }
    }
  }, 10_000);
});
