import { Worker, type ResourceLimits } from 'node:worker_threads';
import {
  WorkerCrashedError,
  WorkerPoolClosedError,
  WorkerQueueFullError,
  WorkerTaskError,
  WorkerTaskTimeoutError,
} from './worker-errors.js';
import { isTaskReply } from './worker-protocol.js';

export type WorkerPoolOptions = {
  size: number;
  workerFile: string | URL;
  maxQueue?: number;
  taskTimeoutMs?: number;
  resourceLimits?: ResourceLimits;
};

export type WorkerPool = {
  readonly size: number;
  readonly closed: boolean;
  run<T = unknown>(payload: unknown, options?: { timeoutMs?: number }): Promise<T>;
  close(): Promise<void>;
};

type QueuedTask = {
  id: number;
  payload: unknown;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type ActiveTask = QueuedTask & { timer: NodeJS.Timeout | undefined; settled: boolean };

type Slot = { worker: Worker | undefined; task: ActiveTask | undefined };

type Outcome = { value: unknown } | { error: unknown };

const DEFAULT_MAX_QUEUE = 1024;
const DEFAULT_TASK_TIMEOUT_MS = 30_000;

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function warnTerminateFailure(error: unknown): void {
  process.emitWarning(
    `analyzer worker termination failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export function createWorkerPool(options: WorkerPoolOptions): WorkerPool {
  const size = positiveSafeInteger(options.size, 'size');
  const maxQueue =
    options.maxQueue === undefined
      ? DEFAULT_MAX_QUEUE
      : positiveSafeInteger(options.maxQueue, 'maxQueue');
  const taskTimeoutMs =
    options.taskTimeoutMs === undefined
      ? DEFAULT_TASK_TIMEOUT_MS
      : positiveSafeInteger(options.taskTimeoutMs, 'taskTimeoutMs');
  const { workerFile, resourceLimits } = options;
  if (!(workerFile instanceof URL) && (typeof workerFile !== 'string' || workerFile === '')) {
    throw new TypeError('workerFile must be a non-empty string or a URL');
  }

  const slots: Slot[] = Array.from({ length: size }, () => ({
    worker: undefined,
    task: undefined,
  }));
  const queue: QueuedTask[] = [];
  let nextId = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  function settle(slot: Slot, task: ActiveTask, outcome: Outcome): void {
    if (task.settled) return;
    task.settled = true;
    if (task.timer !== undefined) clearTimeout(task.timer);
    if (slot.task === task) slot.task = undefined;
    if ('error' in outcome) task.reject(outcome.error);
    else task.resolve(outcome.value);
  }

  /** Detach the slot's worker first (so its later `exit` is ignored), then terminate it. */
  function retire(slot: Slot): void {
    const worker = slot.worker;
    slot.worker = undefined;
    if (worker === undefined) return;
    worker.terminate().catch(warnTerminateFailure);
  }

  function afterSettle(slot: Slot, worker: Worker): void {
    if (slot.worker === worker && slot.task === undefined) worker.unref();
    dispatch();
  }

  function spawn(slot: Slot): Worker {
    const worker = new Worker(workerFile, resourceLimits === undefined ? {} : { resourceLimits });
    worker.on('message', (message: unknown) => {
      if (slot.worker !== worker) return;
      const task = slot.task;
      if (task === undefined) return;
      if (!isTaskReply(message) || message.id !== task.id) {
        settle(slot, task, { error: new WorkerCrashedError('worker sent an unexpected reply') });
        retire(slot);
      } else if (message.ok) {
        settle(slot, task, { value: message.value });
      } else {
        settle(slot, task, { error: new WorkerTaskError(message.error) });
      }
      afterSettle(slot, worker);
    });
    worker.on('error', (error: Error) => {
      if (slot.worker !== worker) return;
      const task = slot.task;
      if (task !== undefined) {
        settle(slot, task, {
          error: new WorkerCrashedError(`worker crashed: ${error.message}`, { cause: error }),
        });
      }
      retire(slot);
      dispatch();
    });
    worker.on('exit', (code: number) => {
      if (slot.worker !== worker) return;
      const task = slot.task;
      slot.worker = undefined;
      if (task !== undefined) {
        settle(slot, task, {
          error: new WorkerCrashedError(`worker exited with code ${String(code)}`),
        });
      }
      dispatch();
    });
    slot.worker = worker;
    return worker;
  }

  function dispatch(): void {
    if (closed) return;
    for (const slot of slots) {
      if (slot.task !== undefined) continue;
      const queued = queue.shift();
      if (queued === undefined) return;
      let worker = slot.worker;
      if (worker === undefined) {
        try {
          worker = spawn(slot);
        } catch (error) {
          slot.worker = undefined;
          queued.reject(error);
          continue;
        }
      }
      worker.ref();
      const task: ActiveTask = { ...queued, settled: false, timer: undefined };
      task.timer = setTimeout(() => {
        if (task.settled) return;
        settle(slot, task, { error: new WorkerTaskTimeoutError(task.timeoutMs) });
        retire(slot);
        dispatch();
      }, task.timeoutMs);
      slot.task = task;
      try {
        worker.postMessage({ id: task.id, payload: task.payload });
      } catch (error) {
        settle(slot, task, { error });
        afterSettle(slot, worker);
      }
    }
  }

  function run<T = unknown>(payload: unknown, runOptions?: { timeoutMs?: number }): Promise<T> {
    if (closed) return Promise.reject(new WorkerPoolClosedError());
    let timeoutMs = taskTimeoutMs;
    if (runOptions?.timeoutMs !== undefined) {
      try {
        timeoutMs = positiveSafeInteger(runOptions.timeoutMs, 'timeoutMs');
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new RangeError(String(error)));
      }
    }
    if (queue.length >= maxQueue) return Promise.reject(new WorkerQueueFullError(maxQueue));
    return new Promise<T>((resolve, reject) => {
      nextId += 1;
      queue.push({
        id: nextId,
        payload,
        timeoutMs,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      dispatch();
    });
  }

  function close(): Promise<void> {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    for (const queued of queue.splice(0)) queued.reject(new WorkerPoolClosedError());
    const terminations: Promise<number>[] = [];
    for (const slot of slots) {
      const task = slot.task;
      if (task !== undefined) settle(slot, task, { error: new WorkerPoolClosedError() });
      const worker = slot.worker;
      slot.worker = undefined;
      if (worker !== undefined) terminations.push(worker.terminate());
    }
    closePromise = Promise.allSettled(terminations).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') warnTerminateFailure(result.reason);
      }
    });
    return closePromise;
  }

  return {
    size,
    get closed() {
      return closed;
    },
    run,
    close,
  };
}
