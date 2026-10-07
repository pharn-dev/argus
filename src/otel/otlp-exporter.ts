import type { AggregatedWindow, CollectorListener } from '../collector/index.js';
import { createOtlpBatchQueue } from './otlp-batch-queue.js';
import { resolveOtlpExporterOptions, type OtlpExporterOptions } from './otlp-exporter-options.js';
import { toOtlpMetrics } from './otlp-metrics.js';

export type OtlpMetricsExporterOptions = OtlpExporterOptions;

export type OtlpMetricsExporter = {
  /** Queues one batch for export. Synchronous; never throws, never awaits. */
  export(windows: AggregatedWindow | readonly AggregatedWindow[]): void;
  /** Resolves once the queue is empty and nothing is in flight. Never rejects for an export failure. */
  flush(): Promise<void>;
  /**
   * Stops accepting batches, then flushes for at most `closeTimeoutMs` (default `timeoutMs`);
   * batches still queued then are dropped and reported, the request in flight is aborted.
   * Idempotent.
   */
  close(): Promise<void>;
  readonly droppedBatches: number;
  readonly failedBatches: number;
  /** For `collector.subscribe(exporter.listener)`: one batch per window. */
  readonly listener: CollectorListener;
};

export function createOtlpMetricsExporter(
  options: OtlpMetricsExporterOptions,
): OtlpMetricsExporter {
  const { target, serviceName, queueCapacity, closeTimeoutMs, onError } =
    resolveOtlpExporterOptions(options);
  const queue = createOtlpBatchQueue<AggregatedWindow>({
    capacity: queueCapacity,
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
    listener: {
      window: (window) => {
        exportBatch(window);
      },
    },
  };
}
