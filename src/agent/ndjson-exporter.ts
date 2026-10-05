import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { excludeFromBackpressure } from './backpressure-exclusion.js';
import { createBoundedQueue } from './bounded-queue.js';
import { encodeNdjsonLine } from './ndjson-encoder.js';

export type NdjsonExporterOptions = {
  /** Maximum queued records before the oldest is dropped. Defaults to 1024. */
  queueBound?: number;
};

export type NdjsonExporter = {
  /** Encode one record and queue it for the destination. */
  export(record: unknown): void;
  /** Integer count of records discarded without reaching the destination. */
  readonly dropped: number;
  /** Flush the queue, end the destination, and return `done`. */
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
  // createBoundedQueue validates the bound and throws RangeError.
  const queue = createBoundedQueue<string>(queueBound);
  let dropped = 0;
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
      const line = queue.shift();
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
    while (queue.shift() !== undefined) {
      dropped += 1;
    }
    wakeSource();
  };
  // Observes settlement only; the rejection still reaches every caller of `done`.
  done.then(onClosed, onClosed);

  return {
    export(record: unknown): void {
      if (closed || stopping) {
        dropped += 1;
        return;
      }
      const line = encodeNdjsonLine(record);
      if (queue.push(line)) {
        dropped += 1;
      }
      wakeSource();
    },
    get dropped(): number {
      return dropped;
    },
    stop(): Promise<void> {
      stopping = true;
      wakeSource();
      return done;
    },
    done,
  };
}
