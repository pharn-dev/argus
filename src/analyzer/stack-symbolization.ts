import type { ResourceLimits } from 'node:worker_threads';
import { MalformedSourceMapError } from './source-map-error.js';
import type { SymbolizeResult } from './symbolize-protocol.js';
import { resolveBundledWorkerFile } from './worker-file.js';
import { createWorkerPool, type WorkerPool } from './worker-pool.js';

export type StackFrame = { url: string; line: number; column: number };

export type OriginalPosition = { url: string; line: number; column: number };

export type SymbolizedFrame = StackFrame & {
  original?: OriginalPosition;
  error?: MalformedSourceMapError;
};

type SymbolizeOptions = { pool?: WorkerPool; timeoutMs?: number };

export function createSymbolizationPool(
  options: { size?: number; taskTimeoutMs?: number; resourceLimits?: ResourceLimits } = {},
): WorkerPool {
  return createWorkerPool({
    size: options.size ?? 1,
    workerFile: resolveBundledWorkerFile('symbolize.worker'),
    ...(options.taskTimeoutMs === undefined ? {} : { taskTimeoutMs: options.taskTimeoutMs }),
    ...(options.resourceLimits === undefined ? {} : { resourceLimits: options.resourceLimits }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isResult(value: unknown): value is SymbolizeResult {
  if (!isRecord(value)) return false;
  if (value.status === 'unchanged') return true;
  if (value.status === 'mapped') {
    return typeof value.url === 'string' && isInt(value.line) && isInt(value.column);
  }
  return (
    value.status === 'malformed' &&
    typeof value.file === 'string' &&
    typeof value.reason === 'string'
  );
}

function checkFrames(frames: readonly StackFrame[]): void {
  if (!Array.isArray(frames)) throw new TypeError('frames must be an array');
  frames.forEach((frame: unknown, index: number) => {
    if (
      !isRecord(frame) ||
      typeof frame.url !== 'string' ||
      !isInt(frame.line) ||
      frame.line <= 0 ||
      !isInt(frame.column) ||
      frame.column <= 0
    ) {
      throw new TypeError(
        `frames[${index}] must have a string url and positive integer line and column`,
      );
    }
  });
}

async function runTask(payload: unknown, options: SymbolizeOptions): Promise<unknown> {
  const pool = options.pool ?? createSymbolizationPool();
  try {
    return await pool.run(
      payload,
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    );
  } finally {
    if (options.pool === undefined) await pool.close();
  }
}

export async function symbolizeStackFrames(
  frames: readonly StackFrame[],
  options: SymbolizeOptions = {},
): Promise<SymbolizedFrame[]> {
  checkFrames(frames);
  const payload = {
    frames: frames.map(({ url, line, column }) => ({ url, line, column })),
  };
  const reply = await runTask(payload, options);
  if (!Array.isArray(reply) || reply.length !== frames.length || !reply.every(isResult)) {
    throw new Error('symbolization worker returned an unexpected reply');
  }
  const errors = new Map<string, MalformedSourceMapError>();
  return frames.map((frame, index): SymbolizedFrame => {
    const result = reply[index] as SymbolizeResult;
    if (result.status === 'mapped') {
      const { url, line, column } = result;
      return { ...frame, original: { url, line, column } };
    }
    if (result.status === 'malformed') {
      let error = errors.get(result.file);
      if (error === undefined) {
        error = new MalformedSourceMapError(result.file, result.reason);
        errors.set(result.file, error);
      }
      return { ...frame, error };
    }
    return { ...frame };
  });
}
