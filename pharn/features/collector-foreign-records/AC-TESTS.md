---
spec_id: collector-foreign-records
spec_content_hash: 2353b763b429ce0c87605f61c7ab705b18f5d411456d705a3fda9277b3cd25f9
---

## Files

- `src/collector/collector-foreign-records.ac1.test.ts` — the tests for AC-1
- `src/collector/collector-foreign-records.ac2.test.ts` — the tests for AC-2
- `src/collector/collector-foreign-records.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/collector/collector-foreign-records.ac1.test.ts` | src/collector/index.ts#createNdjsonDecoder(options?: { maxLineBytes?: number; onSkipped?: (skip: { reason: 'invalid'; line: string } | { reason: 'oversized'; bytes: number }) => void }): Transform & { readonly invalid: number; readonly oversized: number } — byte input, object-mode output; `invalid` counts non-object lines, `oversized` counts lines over maxLineBytes
- AC-2 | unit | `src/collector/collector-foreign-records.ac2.test.ts` | src/collector/index.ts#createCollector(options: CollectorOptions & { onIgnored?: (record: unknown, reason: 'foreign' | 'malformed') => void }): Collector & { readonly ignored: number }; consume(source: Readable | AsyncIterable<unknown>): Promise<void> — a sample-kind record has no `type` and all of the keys timestamp, eventLoop, memory, gc, backpressure; the malformed record keeps those keys with `timestamp: null`
- AC-3 | integration | `src/collector/collector-foreign-records.ac3.integration.test.ts` | stream/promises pipeline(byteSource, createNdjsonDecoder({ maxLineBytes }), (records) => collector.consume(records)) over src/collector/index.ts exports createNdjsonDecoder and createCollector; agent lines encoded with src/agent/index.ts#encodeNdjsonLine(record: unknown): string and spans with toSpanRecord
