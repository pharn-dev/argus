---
spec_id: agent-allocation-sampling
spec_content_hash: 63025b8f5b9b93838148e7b6a281c8c67b387d9d9a0daa7a336fcf9ebbdca15c
---

## Files

- `src/agent/allocation-sampling.ac1.integration.test.ts` — the tests for AC-1
- `src/agent/allocation-sampling.ac2.integration.test.ts` — the tests for AC-2
- `src/agent/allocation-sampling.ac3.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/agent/allocation-sampling.ac1.integration.test.ts` | src/agent/index.ts#sampleAllocations(options?: { samplingInterval?: number; durationMs?: number; limit?: number }): Promise<AllocationSite[]> — AllocationSite = { functionName: string; url: string; line: number; bytes: number }; driven in-process (vitest, imported from ./index.js): a named test function retains large arrays on a short setInterval while sampleAllocations({ samplingInterval: 1024, durationMs: 300, limit: 1000 }) runs; the resolved list is non-empty, every site has string functionName and url, Number.isInteger(line), Number.isInteger(bytes) && bytes > 0, bytes non-increasing along the list, and some site's functionName equals the test function's name; interval cleared and retained arrays released after
- AC-2 | integration | `src/agent/allocation-sampling.ac2.integration.test.ts` | src/agent/index.ts#sampleAllocations(options?: { samplingInterval?: number; durationMs?: number; limit?: number }): Promise<AllocationSite[]> — driven in-process (vitest, imported from ./index.js): two calls with { durationMs: 100 } in the same tick, each must return a promise without throwing; the first resolves with an array of sites, the second rejects with an Error whose message contains "already in progress"; after both settle a third call with { durationMs: 100 } resolves with an array of sites
- AC-3 | unit | `src/agent/allocation-sampling.ac3.test.ts` | src/agent/index.ts#sampleAllocations(options?: { samplingInterval?: number; durationMs?: number; limit?: number }): Promise<AllocationSite[]> — driven in-process (vitest, imported from ./index.js): called with samplingInterval values 0, -1, 1.5, NaN and '1024', and separately with durationMs values 0, -5, 2.5 and '100'; each call must return a promise without throwing and reject with an Error whose message contains the invalid option's name ("samplingInterval" or "durationMs"); a following call with { durationMs: 50 } resolves with an array of sites
