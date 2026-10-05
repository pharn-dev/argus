---
spec_id: agent-samplers
spec_content_hash: 4de3b7fa138e2b3380e9c01fed10064b5806a55c77d86825ba43f2184dfd64ad
---

## Files

- `src/agent/samplers.ac1.test.ts` — the tests for AC-1
- `src/agent/samplers.ac2.test.ts` — the tests for AC-2
- `src/agent/samplers.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/agent/samplers.ac1.test.ts` | src/agent/index.ts#createSamplerController(onSample: (sample: AgentSample) => void): SamplerController — start(intervalMs: number): void; stop(): void; AgentSample = { timestamp: number; eventLoop: { min; max; mean; p50; p99 }; memory: { heapUsed; heapTotal; rss; external; arrayBuffers } }
- AC-2 | unit | `src/agent/samplers.ac2.test.ts` | src/agent/index.ts#createSamplerController(onSample: (sample: AgentSample) => void): SamplerController — consecutive samples' eventLoop.max across a ~100 ms synchronous block in one interval
- AC-3 | integration | `src/agent/samplers.ac3.integration.test.ts` | src/agent/index.ts#createSamplerController(onSample).start(intervalMs) twice then stop(); plus a child `process.execPath` process that imports the agent entrypoint (compiled to a temp dir with the installed typescript), only calls start, and must exit on its own with code 0
