---
spec_id: agent-backpressure-probes
spec_content_hash: 063a575a3ae94498260e9cd7179435f94571a8577b8235252678cac1f309d6dd
---

## Files

- `src/agent/backpressure-probes.ac1.integration.test.ts` — the tests for AC-1
- `src/agent/backpressure-probes.ac2.test.ts` — the tests for AC-2
- `src/agent/backpressure-probes.ac3.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/agent/backpressure-probes.ac1.integration.test.ts` | src/agent/index.ts#createBackpressureProbe(options?: { maxHotspots?: number }): BackpressureProbe — enable(): void; disable(): void; sample(): BackpressureSample; BackpressureSample = { events: number; totalStall: number; maxStall: number; hotspots: { site: string; events: number; totalStall: number; maxStall: number }[] }; driven in-process (vitest, imported from ./index.js) against a node:stream Writable with a small highWaterMark and a delayed write callback, stalled and drained a known number of times, then sample() twice; default maxHotspots is 10
- AC-2 | unit | `src/agent/backpressure-probes.ac2.test.ts` | src/agent/index.ts#createBackpressureProbe(): BackpressureProbe — enable() twice then disable() once, comparing node:stream Writable.prototype.write to the original captured before enable (===), plus src/agent/index.ts#createNdjsonExporter(destination: Writable, options?: NdjsonExporterOptions): NdjsonExporter with a stallable destination while the probe is enabled; sample(): BackpressureSample must report zero events
- AC-3 | unit | `src/agent/backpressure-probes.ac3.test.ts` | src/agent/index.ts#createSamplerController(onSample: (sample: AgentSample) => void): SamplerController — start(intervalMs: number): void; stop(): void; AgentSample = { timestamp; eventLoop; memory; gc; backpressure: BackpressureSample }; after stop() node:stream Writable.prototype.write is the original captured before start()
