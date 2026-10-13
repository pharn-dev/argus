import type { CollectorListener, SpanRecord } from '../collector/index.js';
import { createOtlpBatchQueue } from './otlp-batch-queue.js';
import { resolveOtlpExporterOptions, type OtlpExporterOptions } from './otlp-exporter-options.js';
import { toOtlpTraces } from './otlp-traces.js';

export type OtlpTraceExporterOptions = OtlpExporterOptions;

export type OtlpTraceExporter = {
  /**
   * Adds spans to the pending queue. Synchronous; never throws, never awaits. Pending spans are
   * batched: one request carries up to `maxBatchSize` spans and is sent when a full batch is
   * pending or after `flushIntervalMs`. When more than `maxQueueSize` spans are pending, the
   * OLDEST are dropped, counted and reported. Call `close()` or `flush()` before the process
   * exits: spans still pending at exit are not delivered.
   */
  export(spans: SpanRecord | readonly SpanRecord[]): void;
  /**
   * Sends the spans pending at the call and resolves once they, and the request in flight, are
   * done. Never rejects for an export failure.
   */
  flush(): Promise<void>;
  /**
   * Stops accepting spans, then flushes for at most `closeTimeoutMs` (default `timeoutMs`);
   * spans still pending then are dropped and reported, the request in flight is aborted.
   * Spans exported after `close()` are dropped and counted. Idempotent.
   */
  close(): Promise<void>;
  /** Export calls that lost at least one span, each counted once. */
  readonly droppedBatches: number;
  /** Requests that failed, or whose spans could not be encoded. */
  readonly failedBatches: number;
  /** Spans dropped: evicted from a full queue, exported after `close()`, or dropped by `close()`. */
  readonly droppedItems: number;
  /** Spans the endpoint accepted (a 2xx answer). */
  readonly exportedItems: number;
  /** Spans in a failed request, or spans that could not be encoded. */
  readonly failedItems: number;
  /** For `collector.subscribe(exporter.listener)`: one span record per callback. */
  readonly listener: CollectorListener;
};

export function createOtlpTraceExporter(options: OtlpTraceExporterOptions): OtlpTraceExporter {
  const {
    target,
    serviceName,
    flushIntervalMs,
    maxBatchSize,
    maxQueueSize,
    closeTimeoutMs,
    onError,
  } = resolveOtlpExporterOptions(options);
  const queue = createOtlpBatchQueue<SpanRecord>({
    maxBatchSize,
    maxQueueSize,
    flushIntervalMs,
    encode: (batch) => JSON.stringify(toOtlpTraces(batch, { serviceName })),
    target,
    closeTimeoutMs,
    onError,
  });

  function exportBatch(spans: SpanRecord | readonly SpanRecord[]): void {
    queue.push(Array.isArray(spans) ? (spans as readonly SpanRecord[]) : [spans as SpanRecord]);
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
      span: (span) => {
        exportBatch(span);
      },
    },
  };
}
