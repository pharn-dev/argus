---
spec_id: collector-windows
spec_content_hash: 9342a6f9e40a234724bf174a29e016a29738b05d7ab059d80b29afed60d69bec
---

## Files

- `src/collector/collector-windows.ac1.test.ts` — the tests for AC-1
- `src/collector/collector-windows.ac2.test.ts` — the tests for AC-2
- `src/collector/collector-windows.ac3.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/collector/collector-windows.ac1.test.ts` | src/collector/index.ts#createWindowAggregator(options: { windowMs: number }): Transform — object-mode node:stream Transform; write AgentSample objects (from src/agent/index.ts), read AggregatedWindow = { start; end; count; late; eventLoop: { max; p99; mean }; memory: { heapUsedLast; heapUsedMax; rssLast; rssMax }; gc: { count; totalPause; maxPause }; backpressure: { events; totalStall; maxStall } }; first window observed after the 2500 sample's write, second after end()
- AC-2 | unit | `src/collector/collector-windows.ac2.test.ts` | src/collector/index.ts#createWindowAggregator(options: { windowMs: number }): Transform — writes at 1500, 2100, 1200, 900, 2200, 3100 then end(); assert every emitted AggregatedWindow's start, count and late
- AC-3 | unit | `src/collector/collector-windows.ac3.test.ts` | src/collector/index.ts#createCollector(options: { windowMs: number; capacity: number }): Collector — consume(source: Readable | AsyncIterable<AgentSample>): Promise<void>; windows: RingBuffer<AggregatedWindow> with snapshot(): AggregatedWindow[] (newest last); a node:stream Readable.from source for the resolve case and a Readable that emits an error (destroy(err)) for the reject case
