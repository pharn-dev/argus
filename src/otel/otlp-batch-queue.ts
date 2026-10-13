import { createDropReporter } from './otlp-drop-reporter.js';
import { createPendingItems, type PendingEntry } from './otlp-pending-items.js';
import { postOtlpJson, type OtlpTarget } from './otlp-transport.js';

export type OtlpBatchQueueOptions<T> = {
  /** Most items sent in one request. The effective size is `min(maxBatchSize, maxQueueSize)`. */
  maxBatchSize: number;
  /** Most items held pending; when full, the OLDEST pending item is dropped. */
  maxQueueSize: number;
  /** How long the oldest pending items wait for a full batch before they are sent anyway. */
  flushIntervalMs: number;
  /** Serialises one batch to an OTLP JSON body. May throw: the throwing items are isolated. */
  encode: (batch: readonly T[]) => string;
  target: OtlpTarget;
  /** How long `close()` waits for pending items before dropping them and aborting the request. */
  closeTimeoutMs: number;
  onError: ((error: Error) => void) | undefined;
};

export type OtlpBatchQueue<T> = {
  /**
   * Adds the items of one export call. Synchronous; never throws, never awaits. An empty call is
   * ignored. When the queue is full, the oldest pending items are dropped to make room.
   */
  push(batch: readonly T[]): void;
  /**
   * Resolves once the items pending at the call, and the request in flight, are done. Never
   * rejects for an export failure.
   */
  flush(): Promise<void>;
  /**
   * Stops accepting items, then flushes for at most `closeTimeoutMs`. When that elapses, the items
   * still pending are dropped (counted, reported once through `onError`) and the request in
   * flight is aborted (counted as failed). Idempotent.
   */
  close(): Promise<void>;
  /** Export calls that lost at least one item, each counted once. */
  readonly droppedBatches: number;
  /** Requests that failed, or whose items could not be encoded. */
  readonly failedBatches: number;
  /** Items dropped: evicted from a full queue, pushed after `close()`, or dropped by `close()`. */
  readonly droppedItems: number;
  /** Items the endpoint accepted (a 2xx answer). */
  readonly exportedItems: number;
  /** Items in a failed request, or items that could not be encoded. */
  readonly failedItems: number;
};

/** At most one drop report per this long; the drops in between are aggregated into one. */
const DROP_REPORT_INTERVAL_MS = 1000;
/** The largest delay `setTimeout` accepts; a larger one would fire after 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * A bounded drop-oldest queue that batches items into OTLP requests, one request at a time. A
 * request is sent as soon as `min(maxBatchSize, maxQueueSize)` items are pending, or when the
 * oldest pending items have waited `flushIntervalMs`. Memory is bounded by `maxQueueSize` pending
 * items plus the items of the one request in flight. Counters only ever grow, by integers. The
 * flush timer is `unref()`ed and armed only while items are pending, so an idle queue holds none.
 */
export function createOtlpBatchQueue<T>(options: OtlpBatchQueueOptions<T>): OtlpBatchQueue<T> {
  const { maxQueueSize, flushIntervalMs, encode, target, closeTimeoutMs, onError } = options;
  const batchSize = Math.min(options.maxBatchSize, maxQueueSize);

  const pending = createPendingItems<T>(maxQueueSize);
  let closed = false;
  let droppedBatches = 0;
  let failedBatches = 0;
  let droppedItems = 0;
  let exportedItems = 0;
  let failedItems = 0;
  /** The running drain loop, if any. At most one, so at most one request is ever open. */
  let drain: Promise<void> | undefined;
  /** True while a request is in flight. */
  let sending = false;
  /** How many of the oldest pending items must be sent now, whatever the batch size. */
  let due = 0;
  let timer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let settledWaiters: (() => void)[] = [];
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

  const dropReporter = createDropReporter({
    intervalMs: DROP_REPORT_INTERVAL_MS,
    report,
    describe: (count) =>
      new Error(
        `OTLP export to ${target.origin}: dropped ${String(count)} item(s); the export queue was full or the exporter was closed`,
      ),
  });

  function countDropped(entries: readonly PendingEntry<T>[]): void {
    droppedItems += entries.length;
    for (const { call } of entries) {
      if (!call.dropped) {
        call.dropped = true;
        droppedBatches += 1;
      }
    }
  }

  function failRequest(count: number, error: Error): void {
    failedBatches += 1;
    failedItems += count;
    report(error);
  }

  function clearTimer(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  /** Whether the pending items at the last `flush()`/timer fire are sent and nothing is in flight. */
  function isSettled(): boolean {
    return !sending && (pending.size === 0 || due === 0);
  }

  function notifySettled(): void {
    if (!isSettled()) return;
    const waiters = settledWaiters;
    settledWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function whenSettled(): Promise<void> {
    if (isSettled()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      settledWaiters.push(resolve);
    });
  }

  function isDue(): boolean {
    return pending.size > 0 && (pending.size >= batchSize || due > 0);
  }

  function armTimer(): void {
    if (timer !== undefined || closed || pending.size === 0) return;
    timer = setTimeout(onTimer, Math.min(flushIntervalMs, MAX_TIMER_DELAY_MS));
    timer.unref();
  }

  function onTimer(): void {
    timer = undefined;
    due = pending.size;
    startDrain();
  }

  /**
   * Encodes `items`. When the batch cannot be encoded, each item is tried alone: the items that
   * throw are counted failed and reported (the error names the field, never the value), and the
   * rest still go out in one body, so a malformed record costs only itself.
   */
  function encodeBatch(items: readonly T[]): { body: string; count: number } | undefined {
    try {
      return { body: encode(items), count: items.length };
    } catch (cause) {
      const batchError = toError(cause);
      const survivors: T[] = [];
      let firstError: Error | undefined;
      for (const item of items) {
        try {
          encode([item]);
          survivors.push(item);
        } catch (itemCause) {
          firstError ??= toError(itemCause);
        }
      }
      if (firstError === undefined) {
        // Each item encodes alone; only the combination fails.
        failRequest(items.length, batchError);
        return undefined;
      }
      failRequest(items.length - survivors.length, firstError);
      if (survivors.length === 0) return undefined;
      try {
        return { body: encode(survivors), count: survivors.length };
      } catch (survivorsCause) {
        failRequest(survivors.length, toError(survivorsCause));
        return undefined;
      }
    }
  }

  async function sendBatch(entries: readonly PendingEntry<T>[]): Promise<void> {
    const encoded = encodeBatch(entries.map((entry) => entry.item));
    if (encoded === undefined) return;
    const error = await postOtlpJson(target, encoded.body, abortOnClose.signal);
    if (error === undefined) exportedItems += encoded.count;
    else failRequest(encoded.count, error);
  }

  /**
   * Sends coalesced requests one after another while there is due work. Every path is inside
   * `try`/`catch`/`finally`, so the promise never rejects.
   */
  async function drainLoop(): Promise<void> {
    try {
      while (isDue()) {
        const entries = pending.take(batchSize);
        due = Math.max(0, due - entries.length);
        if (pending.size === 0) clearTimer();
        sending = true;
        try {
          await sendBatch(entries);
        } catch (cause) {
          failRequest(entries.length, toError(cause));
        } finally {
          sending = false;
          notifySettled();
        }
      }
    } finally {
      drain = undefined;
      armTimer();
      notifySettled();
    }
  }

  /** Starts the drain loop when there is due work and none is running. */
  function startDrain(): void {
    // `isDue()` guarantees the loop's first iteration awaits, so `drain` is set before it can end.
    if (drain === undefined && isDue()) drain = drainLoop();
  }

  function push(batch: readonly T[]): void {
    const items = [...batch];
    if (items.length === 0) return;
    const call = { dropped: false };
    if (closed) {
      droppedItems += items.length;
      droppedBatches += 1;
      dropReporter.add(items.length);
      return;
    }
    let evictedCount = 0;
    for (const item of items) {
      const evicted = pending.push({ item, call });
      if (evicted === undefined) continue;
      countDropped([evicted]);
      due = Math.max(0, due - 1);
      evictedCount += 1;
    }
    dropReporter.add(evictedCount);
    startDrain();
    armTimer();
  }

  async function flush(): Promise<void> {
    due = pending.size;
    startDrain();
    await whenSettled();
    dropReporter.flushNow();
  }

  function dropPending(): void {
    const entries = pending.clear();
    due = 0;
    if (entries.length === 0) return;
    countDropped(entries);
    report(
      new Error(
        `OTLP export to ${target.origin}: close() timed out after ${String(closeTimeoutMs)}ms; dropped ${String(entries.length)} item(s)`,
      ),
    );
  }

  async function shutdown(): Promise<void> {
    closed = true;
    clearTimer();
    due = pending.size;
    startDrain();
    if (!isSettled()) {
      let deadlineTimer: NodeJS.Timeout | undefined;
      const deadline = new Promise<boolean>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(false), closeTimeoutMs);
      });
      const settled = await Promise.race([whenSettled().then(() => true), deadline]);
      clearTimeout(deadlineTimer);
      if (!settled) {
        // Empty the queue before aborting, so the drain loop has nothing left to send.
        dropPending();
        abortOnClose.abort();
        if (drain !== undefined) await drain;
      }
    }
    dropReporter.flushNow();
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
    get droppedItems() {
      return droppedItems;
    },
    get exportedItems() {
      return exportedItems;
    },
    get failedItems() {
      return failedItems;
    },
  };
}
