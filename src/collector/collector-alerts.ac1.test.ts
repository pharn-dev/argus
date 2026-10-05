import type { Transform } from 'node:stream';
import { describe, expect, it } from 'vitest';

type AlertRuleInput = {
  id: string;
  metric: string;
  comparison: string;
  threshold: number;
  forWindows?: number;
};

type AlertOutput = {
  ruleId: string;
  metric: string;
  comparison: string;
  threshold: number;
  observed: number;
  windowStart: number;
  windowEnd: number;
  state: string;
};

type AlertsModule = {
  createAlertEvaluator: (rules: readonly AlertRuleInput[]) => Transform;
};

/** A full AggregatedWindow-shaped object with the two metrics the AC drives. */
function makeWindow(start: number, p99: number, heapUsedMax: number): Record<string, unknown> {
  return {
    start,
    end: start + 1000,
    count: 1,
    late: 0,
    eventLoop: { max: p99, p99, mean: 10 },
    memory: { heapUsedLast: heapUsedMax, heapUsedMax, rssLast: 5000, rssMax: 5000 },
    gc: { count: 0, totalPause: 0, maxPause: 0 },
    backpressure: { events: 0, totalStall: 0, maxStall: 0 },
  };
}

/** Collect every numeric leaf of a value, with its path. */
function numericLeaves(value: unknown, path = ''): Array<[string, number]> {
  if (typeof value === 'number') {
    return [[path, value]];
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      numericLeaves(child, path === '' ? key : `${path}.${key}`),
    );
  }
  return [];
}

describe('collector alerts — AC-1', () => {
  it('AC-1: emits edge-triggered firing and resolved alerts in window then rule order, with integer fields', async () => {
    const alertsModule = (await import('./index.js')) as unknown as AlertsModule;

    const evaluator = alertsModule.createAlertEvaluator([
      { id: 'heap', metric: 'memory.heapUsedMax', comparison: '>=', threshold: 1000 },
      { id: 'lag', metric: 'eventLoop.p99', comparison: '>', threshold: 100, forWindows: 2 },
    ]);

    const p99s = [150, 50, 150, 150, 200, 80, 90];
    const heaps = [999, 1000, 1000, 999, 999, 999, 999];

    const collected: AlertOutput[] = [];
    const drained = (async () => {
      for await (const alert of evaluator) {
        collected.push(alert as AlertOutput);
      }
    })();

    for (let i = 0; i < p99s.length; i += 1) {
      evaluator.write(makeWindow(i * 1000, p99s[i] as number, heaps[i] as number));
    }
    evaluator.end();
    await drained;

    expect(collected).toEqual([
      {
        ruleId: 'heap',
        metric: 'memory.heapUsedMax',
        comparison: '>=',
        threshold: 1000,
        observed: 1000,
        windowStart: 1000,
        windowEnd: 2000,
        state: 'firing',
      },
      {
        ruleId: 'heap',
        metric: 'memory.heapUsedMax',
        comparison: '>=',
        threshold: 1000,
        observed: 999,
        windowStart: 3000,
        windowEnd: 4000,
        state: 'resolved',
      },
      {
        ruleId: 'lag',
        metric: 'eventLoop.p99',
        comparison: '>',
        threshold: 100,
        observed: 150,
        windowStart: 3000,
        windowEnd: 4000,
        state: 'firing',
      },
      {
        ruleId: 'lag',
        metric: 'eventLoop.p99',
        comparison: '>',
        threshold: 100,
        observed: 80,
        windowStart: 5000,
        windowEnd: 6000,
        state: 'resolved',
      },
    ]);

    for (const alert of collected) {
      for (const [path, value] of numericLeaves(alert)) {
        expect(Number.isInteger(value), `${alert.ruleId}.${path} must be an integer`).toBe(true);
      }
    }
  }, 10_000);
});
