---
spec_id: agent-v8-heap
spec_content_hash: 578bb8916e3b3de896ebbb5850bd5da168b7b3ca12a7680f0de3115457a99896
---

## Files

- `src/agent/v8-heap.ac1.test.ts` — the tests for AC-1
- `src/agent/v8-heap.ac2.integration.test.ts` — the tests for AC-2
- `src/agent/v8-heap.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/agent/v8-heap.ac1.test.ts` | src/agent/index.ts#sampleHeapSpaces(): HeapSpaceSample — HeapSpaceSample = { name: string; space_size: number; space_used_size: number; space_available_size: number; physical_space_size: number }[]; plus src/agent/index.ts#createSamplerController(onSample: (sample: AgentSample) => void): SamplerController — start(intervalMs: number): void; stop(): void; AgentSample = { timestamp; eventLoop; memory; gc; backpressure; heapSpaces: HeapSpaceSample }; driven in-process (vitest, imported from ./index.js), started with a short interval, one tick awaited, then stop()
- AC-2 | integration | `src/agent/v8-heap.ac2.integration.test.ts` | src/agent/index.ts#takeHeapSnapshot(options: { dir: string }): Promise<{ path: string; bytes: number }> — driven in-process (vitest, imported from ./index.js) against a mkdtempSync temp directory, awaited twice in sequence; each resolved path is checked for dirname, `.heapsnapshot` suffix, distinctness, statSync size === bytes > 0, and JSON.parse of the file content having snapshot.meta; temp directory removed after
- AC-3 | integration | `src/agent/v8-heap.ac3.integration.test.ts` | src/agent/index.ts#takeHeapSnapshot(options: { dir: string }): Promise<{ path: string; bytes: number }> — driven in-process (vitest, imported from ./index.js): called with a non-existent path under a temp dir, with a temp dir chmod 0o500, and twice in the same tick against a writable temp dir; each call must return a promise without throwing; the first two reject with an Error whose message contains the directory and leave no `.heapsnapshot` file; of the same-tick pair the first resolves and the second rejects with an Error whose message contains "already in progress"; permissions restored and temp dirs removed after
