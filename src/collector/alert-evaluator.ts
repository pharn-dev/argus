import { Transform } from 'node:stream';
import {
  readAlertMetric,
  validateAlertRules,
  type AlertComparison,
  type AlertMetric,
  type AlertRule,
} from './alert-rules.js';
import type { AggregatedWindow } from './window.js';

export type AlertState = 'firing' | 'resolved';

export type Alert = {
  ruleId: string;
  metric: AlertMetric;
  comparison: AlertComparison;
  threshold: number;
  observed: number;
  windowStart: number;
  windowEnd: number;
  state: AlertState;
};

/** Object-mode Transform: AggregatedWindow in, edge-triggered Alert out, in rule order. */
export function createAlertEvaluator(rules: readonly AlertRule[]): Transform {
  const resolved = validateAlertRules(rules);
  const states = resolved.map(() => ({ consecutive: 0, firing: false }));

  return new Transform({
    objectMode: true,
    transform(window: AggregatedWindow, _encoding, callback): void {
      try {
        const out: Alert[] = [];
        resolved.forEach((rule, i) => {
          const state = states[i] as { consecutive: number; firing: boolean };
          const observed = readAlertMetric(window, rule.metric);
          if (!Number.isSafeInteger(observed) || observed < 0) {
            throw new TypeError(
              `alert rule "${rule.id}": metric ${rule.metric} is not a non-negative safe integer`,
            );
          }
          const breach =
            rule.comparison === '>' ? observed > rule.threshold : observed >= rule.threshold;
          const alert = (alertState: AlertState): Alert => ({
            ruleId: rule.id,
            metric: rule.metric,
            comparison: rule.comparison,
            threshold: rule.threshold,
            observed,
            windowStart: window.start,
            windowEnd: window.end,
            state: alertState,
          });
          if (breach) {
            if (!state.firing) {
              state.consecutive = Math.min(state.consecutive + 1, rule.forWindows);
              if (state.consecutive === rule.forWindows) {
                state.firing = true;
                out.push(alert('firing'));
              }
            }
          } else {
            state.consecutive = 0;
            if (state.firing) {
              state.firing = false;
              out.push(alert('resolved'));
            }
          }
        });
        for (const alert of out) {
          this.push(alert);
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}
