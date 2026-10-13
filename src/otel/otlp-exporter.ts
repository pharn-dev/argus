import type { AggregatedWindow, CollectorListener } from '../collector/index.js';
import { createOtlpBatchQueue } from './otlp-batch-queue.js';
import { resolveOtlpExporterOptions, type OtlpExporterOptions } from './otlp-exporter-options.js';
import { toOtlpMetrics } from './otlp-metrics.js';

export type OtlpMetricsExporterOptions = OtlpExporterOptions;

export type OtlpMetricsExporter = {
  /**
   * Adds windows to the pending queue. Synchronous; never throws, never awaits. Pending windows
   * are batched: one request carries up to `maxBatchSize` windows and is sent when a full batch
   * is pending or after `flushIntervalMs`. When more than `maxQueueSize` windows are pending, the
   * OLDEST are dropped, counted and reported. Call `close()` or `flush()` before the process
   * exits: windows still pending at exit are not delivered.
   */
  export(windows: AggregatedWindow | readonly AggregatedWindow[]): void;
  /**
   * Sends the windows pending at the call and resolves once they, and the request in flight, are
   * done. Never rejects for an export failure.
   */
  flush(): Promise<void>;
  /**
   * Stops accepting windows, then flushes for at most `closeTimeoutMs` (default `timeoutMs`);
   * windows still pending then are dropped and reported, the request in flight is aborted.
   * Windows exported after `close()` are dropped and counted. Idempotent.
   */
  close(): Promise<void>;
  /** Export calls that lost at least one window, each counted once. */
  readonly droppedBatches: number;
  /** Requests that failed, or whose windows could not be encoded. */
  readonly failedBatches: number;
  /** Windows dropped: evicted from a full queue, exported after `close()`, or dropped by `close()`. */
  readonly droppedItems: number;
  /** Windows the endpoint accepted (a 2xx answer). */
  readonly exportedItems: number;
  /** Windows in a failed request, or windows that could not be encoded. */
  readonly failedItems: number;
  /** For `collector.subscribe(exporter.listener)`: one window per callback. */
  readonly listener: CollectorListener;
};

export function createOtlpMetricsExporter(
  options: OtlpMetricsExporterOptions,
): OtlpMetricsExporter {
  const {
    target,
    serviceName,
    flushIntervalMs,
    maxBatchSize,
    maxQueueSize,
    closeTimeoutMs,
    onError,
  } = resolveOtlpExporterOptions(options);
  const queue = createOtlpBatchQueue<AggregatedWindow>({
    maxBatchSize,
    maxQueueSize,
    flushIntervalMs,
    encode: (batch) => JSON.stringify(toOtlpMetrics(batch, { serviceName })),
    target,
    closeTimeoutMs,
    onError,
  });

  function exportBatch(windows: AggregatedWindow | readonly AggregatedWindow[]): void {
    queue.push(
      Array.isArray(windows)
        ? (windows as readonly AggregatedWindow[])
        : [windows as AggregatedWindow],
    );
  }

  return {
    export: exportBatch,
    flush: () => queue.flush(),
    close: () => queue.close(),
    get droppedBatches() {
      return queue.droppedBatches;
    },
    get failedBatches() {
      return queue.failedBatches;
    },
    get droppedItems() {
      return queue.droppedItems;
    },
    get exportedItems() {
      return queue.exportedItems;
    },
    get failedItems() {
      return queue.failedItems;
    },
    listener: {
      window: (window) => {
        exportBatch(window);
      },
    },
  };
}
