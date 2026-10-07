import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { excludeFromBackpressure } from './backpressure-exclusion.js';
import { createBoundedQueue } from './bounded-queue.js';
import { encodeNdjsonLine } from './ndjson-encoder.js';

export type NdjsonExporterOptions = {
  /** Maximum queued `export()` records (samples) before the oldest is dropped. Defaults to 1024. */
  queueBound?: number;
  /** Maximum queued `exportSpan()` lines before the oldest span is dropped. Defaults to `queueBound`. */
  spanQueueBound?: number;
};

export type NdjsonExporter = {
  /** Encode one record and queue it for the destination. Spans never evict it. */
  export(record: unknown): void;
  /**
   * Encode one span record and queue it in the span lane. The span lane has its own bound and is
   * written only while no `export()` record is waiting, so a burst of spans never displaces a sample.
   */
  exportSpan(record: unknown): void;
  /** Integer count of records (both lanes) discarded without reaching the destination. */
  readonly dropped: number;
  /** Integer count of `export()` records discarded without reaching the destination. */
  readonly droppedRecords: number;
  /** Integer count of `exportSpan()` records discarded without reaching the destination. */
  readonly droppedSpans: number;
  /** Flush both lanes, end the destination, and return `done`. */
  stop(): Promise<void>;
  /** The pipeline() result: resolves on a clean stop, rejects with the destination's error. */
  readonly done: Promise<void>;
};

const DEFAULT_QUEUE_BOUND = 1024;

export function createNdjsonExporter(
  destination: Writable,
  options: NdjsonExporterOptions = {},
): NdjsonExporter {
  excludeFromBackpressure(destination);
  const queueBound = options.queueBound ?? DEFAULT_QUEUE_BOUND;
  const spanQueueBound = options.spanQueueBound ?? queueBound;
  // createBoundedQueue validates each bound and throws RangeError.
  const records = createBoundedQueue<string>(queueBound);
  const spans = createBoundedQueue<string>(spanQueueBound);
  let droppedRecords = 0;
  let droppedSpans = 0;
  let stopping = false;
  let closed = false;
  let wake: (() => void) | undefined;

  const wakeSource = (): void => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };

  async function* source(): AsyncGenerator<string, void, undefined> {
    for (;;) {
      // Records first: a span line is written only when no sample is waiting.
      const line = records.shift() ?? spans.shift();
      if (line !== undefined) {
        yield line;
        continue;
      }
      if (stopping || closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  const done = pipeline(source(), destination);

  const onClosed = (): void => {
    closed = true;
    while (records.shift() !== undefined) {
      droppedRecords += 1;
    }
    while (spans.shift() !== undefined) {
      droppedSpans += 1;
    }
    wakeSource();
  };
  // Observes settlement only; the rejection still reaches every caller of `done`.
  done.then(onClosed, onClosed);

  return {
    export(record: unknown): void {
      if (closed || stopping) {
        droppedRecords += 1;
        return;
      }
      const line = encodeNdjsonLine(record);
      if (records.push(line)) {
        droppedRecords += 1;
      }
      wakeSource();
    },
    exportSpan(record: unknown): void {
      if (closed || stopping) {
        droppedSpans += 1;
        return;
      }
      const line = encodeNdjsonLine(record);
      if (spans.push(line)) {
        droppedSpans += 1;
      }
      wakeSource();
    },
    get dropped(): number {
      return droppedRecords + droppedSpans;
    },
    get droppedRecords(): number {
      return droppedRecords;
    },
    get droppedSpans(): number {
      return droppedSpans;
    },
    stop(): Promise<void> {
      stopping = true;
      wakeSource();
      return done;
    },
    done,
  };
}
