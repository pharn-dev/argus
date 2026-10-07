import type { CollectorListener, SpanRecord } from '../collector/index.js';
import { createOtlpBatchQueue } from './otlp-batch-queue.js';
import { resolveOtlpExporterOptions, type OtlpExporterOptions } from './otlp-exporter-options.js';
import { toOtlpTraces } from './otlp-traces.js';

export type OtlpTraceExporterOptions = OtlpExporterOptions;

export type OtlpTraceExporter = {
  /** Queues one batch for export. Synchronous; never throws, never awaits. */
  export(spans: SpanRecord | readonly SpanRecord[]): void;
  /** Resolves once the queue is empty and nothing is in flight. Never rejects for an export failure. */
  flush(): Promise<void>;
  /** Stops accepting batches, then flushes. Idempotent. */
  close(): Promise<void>;
  readonly droppedBatches: number;
  readonly failedBatches: number;
  /** For `collector.subscribe(exporter.listener)`: one batch per span record. */
  readonly listener: CollectorListener;
};

export function createOtlpTraceExporter(options: OtlpTraceExporterOptions): OtlpTraceExporter {
  const { target, serviceName, queueCapacity, onError } = resolveOtlpExporterOptions(options);
  const queue = createOtlpBatchQueue<SpanRecord>({
    capacity: queueCapacity,
    encode: (batch) => JSON.stringify(toOtlpTraces(batch, { serviceName })),
    target,
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
    listener: {
      span: (span) => {
        exportBatch(span);
      },
    },
  };
}
