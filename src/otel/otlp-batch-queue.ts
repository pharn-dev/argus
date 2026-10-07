import { postOtlpJson, type OtlpTarget } from './otlp-transport.js';

export type OtlpBatchQueueOptions<T> = {
  /** Batches waiting behind the one in flight; a full queue drops the newest batch. */
  capacity: number;
  /** Serialises one batch to an OTLP JSON body. May throw: a throw counts as one failed batch. */
  encode: (batch: readonly T[]) => string;
  target: OtlpTarget;
  onError: ((error: Error) => void) | undefined;
};

export type OtlpBatchQueue<T> = {
  /** Queues one batch. Synchronous; never throws, never awaits. An empty batch is ignored. */
  push(batch: readonly T[]): void;
  /** Resolves once the queue is empty and nothing is in flight. Never rejects for an export failure. */
  flush(): Promise<void>;
  /** Stops accepting batches, then flushes. Idempotent. */
  close(): Promise<void>;
  readonly droppedBatches: number;
  readonly failedBatches: number;
};

/**
 * A bounded drop-newest queue that sends one OTLP request at a time. Memory is bounded by
 * `capacity` batches plus the one in flight. Counters change only by `+= 1`.
 */
export function createOtlpBatchQueue<T>(options: OtlpBatchQueueOptions<T>): OtlpBatchQueue<T> {
  const { capacity, encode, target, onError } = options;

  const queue: T[][] = [];
  let closed = false;
  let droppedBatches = 0;
  let failedBatches = 0;
  let drain: Promise<void> | undefined;

  function report(error: Error): void {
    if (onError !== undefined) {
      try {
        onError(error);
        return;
      } catch {
        // The callback threw; fall through to the warning so the failure is never silent.
      }
    }
    process.emitWarning(error);
  }

  function fail(error: Error): void {
    failedBatches += 1;
    report(error);
  }

  async function sendBatch(batch: T[]): Promise<void> {
    let body: string;
    try {
      body = encode(batch);
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error(String(cause)));
      return;
    }
    const error = await postOtlpJson(target, body);
    if (error !== undefined) fail(error);
  }

  async function drainQueue(): Promise<void> {
    try {
      for (let batch = queue.shift(); batch !== undefined; batch = queue.shift()) {
        try {
          await sendBatch(batch);
        } catch (cause) {
          fail(cause instanceof Error ? cause : new Error(String(cause)));
        }
      }
    } finally {
      drain = undefined;
    }
  }

  function push(batch: readonly T[]): void {
    const copy = [...batch];
    if (copy.length === 0) return;
    if (closed || queue.length >= capacity) {
      droppedBatches += 1;
      return;
    }
    queue.push(copy);
    drain ??= drainQueue();
  }

  async function flush(): Promise<void> {
    while (drain !== undefined) {
      await drain;
    }
  }

  async function close(): Promise<void> {
    closed = true;
    await flush();
  }

  return {
    push,
    flush,
    close,
    get droppedBatches() {
      return droppedBatches;
    },
    get failedBatches() {
      return failedBatches;
    },
  };
}
