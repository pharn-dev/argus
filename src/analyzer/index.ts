export { createWorkerPool, DEFAULT_RESOURCE_LIMITS } from './worker-pool.js';
export type { WorkerPool, WorkerPoolOptions } from './worker-pool.js';
export {
  WorkerCrashedError,
  WorkerPoolClosedError,
  WorkerQueueFullError,
  WorkerTaskError,
  WorkerTaskTimeoutError,
} from './worker-errors.js';
export {
  createHeapSnapshotPool,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  diffHeapSnapshots,
  summarizeHeapSnapshot,
} from './heap-snapshot.js';
export { HeapSnapshotTooLargeError } from './heap-snapshot-error.js';
export {
  createSymbolizationPool,
  DEFAULT_MAX_SOURCE_FILE_BYTES,
  symbolizeStackFrames,
} from './stack-symbolization.js';
export type { OriginalPosition, StackFrame, SymbolizedFrame } from './stack-symbolization.js';
export { MalformedSourceMapError } from './source-map-error.js';
export type {
  HeapSnapshotDiff,
  HeapSnapshotDiffEntry,
  HeapSnapshotSummary,
  HeapSnapshotTypeStats,
} from './heap-snapshot.js';
