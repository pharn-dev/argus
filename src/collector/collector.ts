import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AgentSample, SpanRecord } from '../agent/index.js';
import { createSpanRouter } from './span-router.js';
import { createAlertEvaluator, type Alert } from './alert-evaluator.js';
import { validateAlertRules, type AlertRule } from './alert-rules.js';
import type { AlertSink, SinkErrorHandler } from './alert-sink.js';
import { createSubscriberSet, type CollectorListener } from './collector-subscribers.js';
import { createSinkDispatcher } from './sink-dispatcher.js';
import { createSinks, type SinkInput } from './sink-config.js';
import { createRingBuffer, type RingBuffer } from './ring-buffer.js';
import type { AggregatedWindow } from './window.js';
import { createWindowAggregator } from './window-aggregator.js';
import { createWindowStore, type PersistOptions } from './window-store.js';

export const DEFAULT_SPAN_CAPACITY = 1024;

export type CollectorOptions = {
  windowMs: number;
  capacity: number;
  spanCapacity?: number;
  alerts?: readonly AlertRule[];
  sinks?: readonly SinkInput[];
  onSinkError?: SinkErrorHandler;
  persist?: PersistOptions;
};

/** Live view over the window store; counters are integers. */
export type WindowPersistence = {
  readonly path: string;
  readonly maxBytes: number;
  readonly skipped: number;
  readonly restored: number;
  readonly bytes: number;
};

export type Collector = {
  readonly windows: RingBuffer<AggregatedWindow>;
  readonly alerts: RingBuffer<Alert>;
  readonly spans: RingBuffer<SpanRecord>;
  readonly sinks: readonly AlertSink[];
  readonly persistence: WindowPersistence | undefined;
  subscribe(listener: CollectorListener): () => void;
  consume(source: Readable | AsyncIterable<AgentSample | SpanRecord>): Promise<void>;
  close(): Promise<void>;
};

export function createCollector(options: CollectorOptions): Collector {
  const { windowMs, capacity } = options;
  const rules = options.alerts ?? [];
  // Validate eagerly; both factories throw RangeError on bad input.
  createWindowAggregator({ windowMs });
  const windows = createRingBuffer<AggregatedWindow>(capacity);
  const alerts = createRingBuffer<Alert>(capacity);
  const spans = createRingBuffer<SpanRecord>(options.spanCapacity ?? DEFAULT_SPAN_CAPACITY);
  validateAlertRules(rules);
  const sinks = createSinks(options.sinks ?? [], options.onSinkError);
  const dispatcher = createSinkDispatcher(sinks, options.onSinkError);
  const store =
    options.persist === undefined ? undefined : createWindowStore({ ...options.persist, capacity });
  let restoring: Promise<void> | undefined;
  const restoreOnce = (): Promise<void> => {
    if (store === undefined) {
      return Promise.resolve();
    }
    restoring ??= store.restore().then((restored) => {
      for (const window of restored) {
        windows.push(window);
      }
    });
    return restoring;
  };
  const subscribers = createSubscriberSet();

  return {
    windows,
    alerts,
    spans,
    sinks,
    persistence: store,
    subscribe(listener: CollectorListener): () => void {
      return subscribers.add(listener);
    },
    async consume(source: Readable | AsyncIterable<AgentSample | SpanRecord>): Promise<void> {
      const spanRouter = createSpanRouter((span) => {
        spans.push(span);
        subscribers.emitSpan(span);
      });
      const aggregator = createWindowAggregator({ windowMs });
      const recordWindows = new Transform({
        objectMode: true,
        transform(window: AggregatedWindow, _encoding, callback): void {
          try {
            windows.push(window);
            subscribers.emitWindow(window);
            callback(null, window);
          } catch (error) {
            callback(error as Error);
          }
        },
      });
      const persistWindows = new Transform({
        objectMode: true,
        transform(window: AggregatedWindow, _encoding, callback): void {
          if (store === undefined) {
            callback(null, window);
            return;
          }
          store.append(window).then(
            () => callback(null, window),
            (error: unknown) => callback(error as Error),
          );
        },
      });
      let failure: unknown;
      let failed = false;
      try {
        await restoreOnce();
        await pipeline(
          source,
          spanRouter,
          aggregator,
          recordWindows,
          persistWindows,
          createAlertEvaluator(rules),
          async function (emitted: AsyncIterable<unknown>) {
            for await (const alert of emitted) {
              alerts.push(alert as Alert);
              subscribers.emitAlert(alert as Alert);
              dispatcher.deliver(alert as Alert);
            }
          },
        );
      } catch (error) {
        failure = error;
        failed = true;
      }
      await dispatcher.settle();
      if (store !== undefined) {
        try {
          await store.release();
        } catch (releaseError) {
          if (!failed) {
            throw releaseError;
          }
          throw new AggregateError(
            [failure, releaseError],
            'consume failed and the window store could not be released',
            { cause: releaseError },
          );
        }
      }
      if (failed) {
        throw failure;
      }
    },
    async close(): Promise<void> {
      await dispatcher.close();
      await store?.release();
    },
  };
}
