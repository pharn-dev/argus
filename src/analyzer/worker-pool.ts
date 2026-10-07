import { Worker, type ResourceLimits, type WorkerOptions } from 'node:worker_threads';
import {
  WorkerCrashedError,
  WorkerPoolClosedError,
  WorkerQueueFullError,
  WorkerTaskError,
  WorkerTaskTimeoutError,
} from './worker-errors.js';
import { portableExecArgv, workerExecArgv } from './worker-exec-argv.js';
import { isTaskReply } from './worker-protocol.js';

export type WorkerPoolOptions = {
  size: number;
  workerFile: string | URL;
  maxQueue?: number;
  taskTimeoutMs?: number;
  /**
   * Per-worker V8 heap limits. Fields left out take the defaults in `DEFAULT_RESOURCE_LIMITS`
   * (old generation 512 MiB, young generation 64 MiB): every worker always runs with limits.
   * Limits are best-effort: Node terminates a worker that reaches them (the task rejects with
   * `ERR_WORKER_CRASHED` and the pool replaces the worker) only while the worker runs interruptible
   * JavaScript. A single native operation that allocates well past the limit (`JSON.parse` or
   * `readFile(..., 'utf8')` of a large input) can make V8 abort the whole process instead, so a
   * worker that parses input must cap that input relative to its heap (the analyzer's own workers
   * do).
   */
  resourceLimits?: ResourceLimits;
};

export type WorkerPool = {
  readonly size: number;
  readonly closed: boolean;
  /**
   * The heap limits every worker of this pool runs with (defaults merged in). Always set by
   * `createWorkerPool`; optional so that hand-written pools stay assignable.
   */
  readonly resourceLimits?: Readonly<ResourceLimits>;
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

/**
 * Applied to every worker unless the caller overrides a field. 512 MiB of old generation fits the
 * analyzer's capped inputs with a wide margin while keeping a runaway worker from growing towards
 * the host's own heap; a 64 MiB young generation keeps short-lived parse garbage in cheap
 * scavenges instead of promoting it into the old generation, whose limit is what terminates a
 * worker.
 */
export const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: 64,
}) satisfies Readonly<ResourceLimits>;

const RESOURCE_LIMIT_KEYS = [
  'maxOldGenerationSizeMb',
  'maxYoungGenerationSizeMb',
  'codeRangeSizeMb',
  'stackSizeMb',
] as const;

/** The caller's limits validated, over the defaults. */
function checkResourceLimits(value: ResourceLimits | undefined): Readonly<ResourceLimits> {
  if (value !== undefined && (typeof value !== 'object' || value === null)) {
    throw new TypeError('resourceLimits must be an object');
  }
  const limits: ResourceLimits = { ...DEFAULT_RESOURCE_LIMITS };
  for (const key of RESOURCE_LIMIT_KEYS) {
    const field: unknown = value?.[key];
    if (field === undefined) continue;
    if (typeof field !== 'number' || !Number.isFinite(field) || field <= 0) {
      throw new RangeError(`resourceLimits.${key} must be a positive finite number`);
    }
    limits[key] = field;
  }
  return Object.freeze(limits);
}

/** A new Worker with the given limits and an execArgv free of host entry-point flags (F-19). */
function startWorker(workerFile: string | URL, resourceLimits: ResourceLimits): Worker {
  const execArgv = workerExecArgv();
  const options: WorkerOptions = { resourceLimits: { ...resourceLimits } };
  if (execArgv === undefined) return new Worker(workerFile, options);
  try {
    return new Worker(workerFile, { ...options, execArgv });
  } catch (error) {
    // The host also has V8 or per-process flags a Worker cannot take explicitly: keep only the
    // per-environment flags known to be accepted.
    if ((error as { code?: unknown } | null)?.code !== 'ERR_WORKER_INVALID_EXEC_ARGV') throw error;
    return new Worker(workerFile, { ...options, execArgv: portableExecArgv(execArgv) });
  }
}

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
  const { workerFile } = options;
  const resourceLimits = checkResourceLimits(options.resourceLimits);
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
    const worker = startWorker(workerFile, resourceLimits);
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
    resourceLimits,
    run,
    close,
  };
}
