---
spec_id: analyzer-worker-pool
spec_content_hash: 438827a9fd0efb534bd1a51e0fb22f6a7d0bf85c0c5af1ab4853b1569049722f
---

## Files

- `src/analyzer/analyzer-worker-pool.ac1.integration.test.ts` — the tests for AC-1
- `src/analyzer/analyzer-worker-pool.ac2.integration.test.ts` — the tests for AC-2
- `src/analyzer/analyzer-worker-pool.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/analyzer/analyzer-worker-pool.ac1.integration.test.ts` | src/analyzer/index.ts#createWorkerPool(options: { size: number; workerFile: string | URL; maxQueue?: number; taskTimeoutMs?: number }): WorkerPool — WorkerPool = { size: number; closed: boolean; run<T = unknown>(payload: unknown, options?: { timeoutMs?: number }): Promise<T>; close(): Promise<void> }; workerFile = new URL('./workers/test-task.worker.ts', import.meta.url), the build-written fixture whose payload { kind: 'echo', ... } resolves with the payload unchanged, { kind: 'crash' } throws inside the worker and { kind: 'hang' } never replies; observed: echo resolves deep-equal to its payload, crash rejects with an Error (WorkerCrashedError, code 'ERR_WORKER_CRASHED'), hang with { timeoutMs: 300 } rejects with WorkerTaskTimeoutError (code 'ERR_WORKER_TASK_TIMEOUT'), a following echo resolves, then a hang task plus two un-awaited tasks are queued and close() makes both queued tasks reject with WorkerPoolClosedError (code 'ERR_WORKER_POOL_CLOSED'); a process 'unhandledRejection' listener records nothing
- AC-2 | integration | `src/analyzer/analyzer-worker-pool.ac2.integration.test.ts` | src/analyzer/index.ts#summarizeHeapSnapshot(path: string, options?: { top?: number; pool?: WorkerPool; timeoutMs?: number }): Promise<HeapSnapshotSummary> — HeapSnapshotSummary = { nodeCount: number; totalSelfSize: number; top: Array<{ name: string; count: number; selfSize: number }> }; a snapshot from node:v8 writeHeapSnapshot(join(await mkdtemp(join(tmpdir(), ...)), 'a.heapsnapshot')) taken while the test holds 10000 instances of a uniquely named class; called with { top: 50 }
- AC-3 | integration | `src/analyzer/analyzer-worker-pool.ac3.integration.test.ts` | src/analyzer/index.ts#diffHeapSnapshots(beforePath: string, afterPath: string, options?: { top?: number; pool?: WorkerPool; timeoutMs?: number }): Promise<HeapSnapshotDiff> — HeapSnapshotDiff = { entries: Array<{ name: string; countDelta: number; selfSizeDelta: number }>; before: { nodeCount: number; totalSelfSize: number }; after: { nodeCount: number; totalSelfSize: number } }; two snapshots from node:v8 writeHeapSnapshot into an fs.mkdtemp(os.tmpdir()) directory, the second taken while the test holds 5000 instances of a uniquely named class absent at the first; called with { top: 20 }
