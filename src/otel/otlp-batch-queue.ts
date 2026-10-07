import { postOtlpJson, type OtlpTarget } from './otlp-transport.js';

export type OtlpBatchQueueOptions<T> = {
  /** Batches waiting behind the one in flight; a full queue drops the newest batch. */
  capacity: number;
  /** Serialises one batch to an OTLP JSON body. May throw: a throw counts as one failed batch. */
  encode: (batch: readonly T[]) => string;
  target: OtlpTarget;
  /** How long `close()` waits for the queue to drain before dropping it and aborting the request. */
  closeTimeoutMs: number;
  onError: ((error: Error) => void) | undefined;
};

export type OtlpBatchQueue<T> = {
  /** Queues one batch. Synchronous; never throws, never awaits. An empty batch is ignored. */
  push(batch: readonly T[]): void;
  /** Resolves once the queue is empty and nothing is in flight. Never rejects for an export failure. */
  flush(): Promise<void>;
  /**
   * Stops accepting batches, then flushes for at most `closeTimeoutMs`. When that elapses, the
   * batches still queued are dropped (counted in `droppedBatches`, reported once through
   * `onError`) and the request in flight is aborted (counted in `failedBatches`). Idempotent.
   */
  close(): Promise<void>;
  readonly droppedBatches: number;
  readonly failedBatches: number;
};

/**
 * A bounded drop-newest queue that sends one OTLP request at a time. Memory is bounded by
 * `capacity` batches plus the one in flight. Counters only ever grow, by integers.
 */
export function createOtlpBatchQueue<T>(options: OtlpBatchQueueOptions<T>): OtlpBatchQueue<T> {
  const { capacity, encode, target, closeTimeoutMs, onError } = options;

  const queue: T[][] = [];
  let closed = false;
  let droppedBatches = 0;
  let failedBatches = 0;
  let drain: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  /** Aborted when `close()` gives up waiting: cancels the request in flight. */
  const abortOnClose = new AbortController();

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
    const error = await postOtlpJson(target, body, abortOnClose.signal);
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

  function dropQueued(): void {
    const count = queue.length;
    if (count === 0) return;
    queue.length = 0;
    droppedBatches += count;
    report(
      new Error(
        `OTLP export to ${target.origin}: close() timed out after ${String(closeTimeoutMs)}ms; dropped ${String(count)} queued batch(es)`,
      ),
    );
  }

  async function shutdown(): Promise<void> {
    closed = true;
    if (drain === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), closeTimeoutMs);
    });
    const drained = await Promise.race([flush().then(() => true), deadline]);
    clearTimeout(timer);
    if (!drained) {
      // Empty the queue before aborting, so the drain loop has nothing left to send.
      dropQueued();
      abortOnClose.abort();
      await flush();
    }
  }

  function close(): Promise<void> {
    closing ??= shutdown();
    return closing;
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
