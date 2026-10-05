import type { AggregatedWindow } from './window.js';

/** The closed set of alertable metrics: every integer field of an AggregatedWindow's sections. */
export const ALERT_METRICS = Object.freeze({
  'eventLoop.max': (w: AggregatedWindow): number => w.eventLoop.max,
  'eventLoop.p99': (w: AggregatedWindow): number => w.eventLoop.p99,
  'eventLoop.mean': (w: AggregatedWindow): number => w.eventLoop.mean,
  'memory.heapUsedLast': (w: AggregatedWindow): number => w.memory.heapUsedLast,
  'memory.heapUsedMax': (w: AggregatedWindow): number => w.memory.heapUsedMax,
  'memory.rssLast': (w: AggregatedWindow): number => w.memory.rssLast,
  'memory.rssMax': (w: AggregatedWindow): number => w.memory.rssMax,
  'gc.count': (w: AggregatedWindow): number => w.gc.count,
  'gc.totalPause': (w: AggregatedWindow): number => w.gc.totalPause,
  'gc.maxPause': (w: AggregatedWindow): number => w.gc.maxPause,
  'backpressure.events': (w: AggregatedWindow): number => w.backpressure.events,
  'backpressure.totalStall': (w: AggregatedWindow): number => w.backpressure.totalStall,
  'backpressure.maxStall': (w: AggregatedWindow): number => w.backpressure.maxStall,
});

export type AlertMetric = keyof typeof ALERT_METRICS;
export type AlertComparison = '>' | '>=';

export type AlertRule = {
  id: string;
  metric: AlertMetric;
  comparison: AlertComparison;
  threshold: number;
  forWindows?: number;
};

export type ResolvedAlertRule = Readonly<Required<AlertRule>>;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function describe(value: unknown): string {
  return typeof value === 'string'
    ? JSON.stringify(value)
    : typeof value === 'number'
      ? String(value)
      : typeof value;
}

/** Validate rules synchronously; throws on the first bad rule, naming its id. Returns frozen copies. */
export function validateAlertRules(rules: readonly AlertRule[]): ResolvedAlertRule[] {
  if (!Array.isArray(rules)) {
    throw new TypeError('alert rules must be an array');
  }
  const seen = new Set<string>();
  const resolved: ResolvedAlertRule[] = [];
  rules.forEach((rule: unknown, index) => {
    // Typed loosely on purpose: JS callers bypass the static types.
    const raw = (rule ?? {}) as Record<string, unknown>;
    if (typeof raw.id !== 'string' || raw.id === '') {
      throw new TypeError(`alert rule at index ${index}: id must be a non-empty string`);
    }
    const id = raw.id;
    const fail = (problem: string): never => {
      throw new RangeError(`alert rule "${id}": ${problem}`);
    };
    if (typeof raw.metric !== 'string' || !Object.hasOwn(ALERT_METRICS, raw.metric)) {
      fail(`unknown metric ${describe(raw.metric)}`);
    }
    if (raw.comparison !== '>' && raw.comparison !== '>=') {
      fail(`comparison must be ">" or ">=", got ${describe(raw.comparison)}`);
    }
    if (!isNonNegativeSafeInteger(raw.threshold)) {
      fail(`threshold must be a non-negative safe integer, got ${describe(raw.threshold)}`);
    }
    let forWindows = 1;
    if (raw.forWindows !== undefined) {
      if (!isNonNegativeSafeInteger(raw.forWindows) || raw.forWindows < 1) {
        fail(`forWindows must be a safe integer >= 1, got ${describe(raw.forWindows)}`);
      }
      forWindows = raw.forWindows as number;
    }
    if (seen.has(id)) {
      fail('duplicate rule id');
    }
    seen.add(id);
    resolved.push(
      Object.freeze({
        id,
        metric: raw.metric as AlertMetric,
        comparison: raw.comparison as AlertComparison,
        threshold: raw.threshold as number,
        forWindows,
      }),
    );
  });
  return resolved;
}

export function readAlertMetric(window: AggregatedWindow, metric: AlertMetric): number {
  return ALERT_METRICS[metric](window);
}
