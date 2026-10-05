import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AgentSample } from '../agent/index.js';
import { createAlertEvaluator, type Alert } from './alert-evaluator.js';
import { validateAlertRules, type AlertRule } from './alert-rules.js';
import { createRingBuffer, type RingBuffer } from './ring-buffer.js';
import type { AggregatedWindow } from './window.js';
import { createWindowAggregator } from './window-aggregator.js';

export type CollectorOptions = {
  windowMs: number;
  capacity: number;
  alerts?: readonly AlertRule[];
};

export type Collector = {
  readonly windows: RingBuffer<AggregatedWindow>;
  readonly alerts: RingBuffer<Alert>;
  consume(source: Readable | AsyncIterable<AgentSample>): Promise<void>;
};

export function createCollector(options: CollectorOptions): Collector {
  const { windowMs, capacity } = options;
  const rules = options.alerts ?? [];
  // Validate eagerly; both factories throw RangeError on bad input.
  createWindowAggregator({ windowMs });
  const windows = createRingBuffer<AggregatedWindow>(capacity);
  const alerts = createRingBuffer<Alert>(capacity);
  validateAlertRules(rules);

  return {
    windows,
    alerts,
    async consume(source: Readable | AsyncIterable<AgentSample>): Promise<void> {
      const aggregator = createWindowAggregator({ windowMs });
      const recordWindows = new Transform({
        objectMode: true,
        transform(window: AggregatedWindow, _encoding, callback): void {
          try {
            windows.push(window);
            callback(null, window);
          } catch (error) {
            callback(error as Error);
          }
        },
      });
      await pipeline(
        source,
        aggregator,
        recordWindows,
        createAlertEvaluator(rules),
        async function (emitted: AsyncIterable<unknown>) {
          for await (const alert of emitted) {
            alerts.push(alert as Alert);
          }
        },
      );
    },
  };
}
