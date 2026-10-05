---
spec_id: agent-gc-events
spec_content_hash: 484b89051d0f701c553ec2645afb6d3e52fbfa6d425e7e2802f0b8e9a4228220
---

## Files

- `src/agent/gc-events.ac1.integration.test.ts` — the tests for AC-1
- `src/agent/gc-events.ac2.test.ts` — the tests for AC-2
- `src/agent/gc-events.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/agent/gc-events.ac1.integration.test.ts` | src/agent/index.ts#createGcSampler(): GcSampler — enable(): void; disable(): void; sample(): GcSample; GcSample = { count: number; totalPause: number; maxPause: number; kinds: { minor: number; major: number; incremental: number; weakcb: number } }; driven in a child `process.execPath --expose-gc` process that imports the agent entrypoint (compiled to a temp dir with the installed typescript): enable then an immediate sample(), then global.gc() and a macrotask wait then sample(), then an immediate third sample(); the child prints the three samples as JSON
- AC-2 | unit | `src/agent/gc-events.ac2.test.ts` | src/agent/index.ts#createSamplerController(onSample: (sample: AgentSample) => void): SamplerController — start(intervalMs: number): void; stop(): void; AgentSample = { timestamp; eventLoop; memory; gc: GcSample }
- AC-3 | integration | `src/agent/gc-events.ac3.integration.test.ts` | src/agent/index.ts#createSamplerController(onSample).start(intervalMs) then stop() in a child `process.execPath` process that imports the agent entrypoint (compiled to a temp dir with the installed typescript), allocates, calls stop(), and prints the sample count at stop() and at process exit; the child must exit on its own with code 0 and both counts must be equal
