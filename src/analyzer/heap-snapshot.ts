import { resolve } from 'node:path';
import type { ResourceLimits } from 'node:worker_threads';
import { resolveBundledWorkerFile } from './worker-file.js';
import { createWorkerPool, type WorkerPool } from './worker-pool.js';

export type HeapSnapshotTypeStats = { name: string; count: number; selfSize: number };

export type HeapSnapshotSummary = {
  nodeCount: number;
  totalSelfSize: number;
  top: HeapSnapshotTypeStats[];
};

export type HeapSnapshotDiffEntry = { name: string; countDelta: number; selfSizeDelta: number };

export type HeapSnapshotDiff = {
  entries: HeapSnapshotDiffEntry[];
  before: { nodeCount: number; totalSelfSize: number };
  after: { nodeCount: number; totalSelfSize: number };
};

type AnalysisOptions = { top?: number; pool?: WorkerPool; timeoutMs?: number };

const DEFAULT_TOP = 20;

export function createHeapSnapshotPool(
  options: { size?: number; taskTimeoutMs?: number; resourceLimits?: ResourceLimits } = {},
): WorkerPool {
  return createWorkerPool({
    size: options.size ?? 1,
    workerFile: resolveBundledWorkerFile('heap-snapshot.worker'),
    ...(options.taskTimeoutMs === undefined ? {} : { taskTimeoutMs: options.taskTimeoutMs }),
    ...(options.resourceLimits === undefined ? {} : { resourceLimits: options.resourceLimits }),
  });
}

function checkPath(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return resolve(value);
}

function checkTop(value: number | undefined): number {
  const top = value ?? DEFAULT_TOP;
  if (!Number.isSafeInteger(top) || top <= 0) {
    throw new RangeError('top must be a positive safe integer');
  }
  return top;
}

async function runTask(payload: unknown, options: AnalysisOptions): Promise<unknown> {
  const pool = options.pool ?? createHeapSnapshotPool();
  try {
    return await pool.run(
      payload,
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    );
  } finally {
    if (options.pool === undefined) await pool.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isTotals(value: unknown): value is { nodeCount: number; totalSelfSize: number } {
  return isRecord(value) && isInt(value.nodeCount) && isInt(value.totalSelfSize);
}

function isSummary(value: unknown): value is HeapSnapshotSummary {
  return (
    isTotals(value) &&
    Array.isArray((value as { top?: unknown }).top) &&
    (value as unknown as HeapSnapshotSummary).top.every(
      (item) =>
        isRecord(item) &&
        typeof item.name === 'string' &&
        isInt(item.count) &&
        isInt(item.selfSize),
    )
  );
}

function isDiff(value: unknown): value is HeapSnapshotDiff {
  return (
    isRecord(value) &&
    isTotals(value.before) &&
    isTotals(value.after) &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item.name === 'string' &&
        isInt(item.countDelta) &&
        isInt(item.selfSizeDelta),
    )
  );
}

export async function summarizeHeapSnapshot(
  path: string,
  options: AnalysisOptions = {},
): Promise<HeapSnapshotSummary> {
  const resolved = checkPath(path, 'path');
  const top = checkTop(options.top);
  const reply = await runTask({ kind: 'summary', path: resolved, top }, options);
  if (!isSummary(reply)) throw new Error('heap snapshot worker returned an unexpected summary');
  return reply;
}

export async function diffHeapSnapshots(
  beforePath: string,
  afterPath: string,
  options: AnalysisOptions = {},
): Promise<HeapSnapshotDiff> {
  const before = checkPath(beforePath, 'beforePath');
  const after = checkPath(afterPath, 'afterPath');
  const top = checkTop(options.top);
  const reply = await runTask({ kind: 'diff', beforePath: before, afterPath: after, top }, options);
  if (!isDiff(reply)) throw new Error('heap snapshot worker returned an unexpected diff');
  return reply;
}
