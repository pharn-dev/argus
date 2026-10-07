/** Errors the worker pool rejects with. Each has a stable `name` and `code`. */

export class WorkerPoolClosedError extends Error {
  readonly code = 'ERR_WORKER_POOL_CLOSED';
  constructor(message = 'worker pool is closed') {
    super(message);
    this.name = 'WorkerPoolClosedError';
  }
}

export class WorkerTaskTimeoutError extends Error {
  readonly code = 'ERR_WORKER_TASK_TIMEOUT';
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`worker task timed out after ${String(timeoutMs)} ms`);
    this.name = 'WorkerTaskTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class WorkerCrashedError extends Error {
  readonly code = 'ERR_WORKER_CRASHED';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkerCrashedError';
  }
}

export class WorkerTaskError extends Error {
  readonly code = 'ERR_WORKER_TASK_FAILED';
  readonly remoteName: string;
  readonly remoteStack: string | undefined;
  constructor(remote: { name: string; message: string; stack?: string }) {
    super(remote.message);
    this.name = 'WorkerTaskError';
    this.remoteName = remote.name;
    this.remoteStack = remote.stack;
  }
}

export class WorkerQueueFullError extends RangeError {
  readonly code = 'ERR_WORKER_QUEUE_FULL';
  constructor(maxQueue: number) {
    super(`worker pool queue is full (maxQueue ${String(maxQueue)})`);
    this.name = 'WorkerQueueFullError';
  }
}
