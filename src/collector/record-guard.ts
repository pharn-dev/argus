import { Transform } from 'node:stream';
import { isSpanRecord } from '../agent/index.js';

/** Why a record was skipped: not agent data at all, or agent-shaped but unusable. */
export type IgnoredReason = 'foreign' | 'malformed';

/** Called once for every skipped record, after the collector's `ignored` counter is incremented. */
export type IgnoredRecordHandler = (record: unknown, reason: IgnoredReason) => void;

/** The keys the agent always writes on a sample line and `addSample` reads. */
const SAMPLE_KEYS = ['timestamp', 'eventLoop', 'memory', 'gc', 'backpressure'] as const;

/** Every numeric field the window aggregator reads, as [group, field]. */
const NUMERIC_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['eventLoop', 'max'],
  ['eventLoop', 'p99'],
  ['eventLoop', 'mean'],
  ['memory', 'heapUsed'],
  ['memory', 'rss'],
  ['gc', 'count'],
  ['gc', 'totalPause'],
  ['gc', 'maxPause'],
  ['backpressure', 'events'],
  ['backpressure', 'totalStall'],
  ['backpressure', 'maxStall'],
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidSample(record: Record<string, unknown>): boolean {
  const { timestamp } = record;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return false;
  }
  for (const [group, field] of NUMERIC_FIELDS) {
    const section = record[group];
    if (!isPlainObject(section) || typeof section[field] !== 'number') {
      return false;
    }
  }
  return true;
}

/**
 * Deterministic key-membership classification of one parsed record.
 * `span` and `sample` are forwarded; `foreign` and `malformed` are skipped.
 */
export function classifyRecord(value: unknown): 'sample' | 'span' | IgnoredReason {
  if (isSpanRecord(value)) {
    return 'span';
  }
  if (!isPlainObject(value) || value['type'] !== undefined) {
    return 'foreign';
  }
  for (const key of SAMPLE_KEYS) {
    if (!(key in value)) {
      return 'foreign';
    }
  }
  return isValidSample(value) ? 'sample' : 'malformed';
}

/**
 * Object-mode Transform that forwards sample and span records unchanged and hands every other
 * record to `onSkip`. A throw from `onSkip` errors the Transform, so the surrounding pipeline rejects.
 */
export function createRecordGuard(
  onSkip: (record: unknown, reason: IgnoredReason) => void,
): Transform {
  return new Transform({
    objectMode: true,
    transform(chunk: unknown, _encoding, callback): void {
      const kind = classifyRecord(chunk);
      if (kind === 'sample' || kind === 'span') {
        callback(null, chunk);
        return;
      }
      try {
        onSkip(chunk, kind);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      callback();
    },
  });
}
