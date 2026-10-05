---
spec_id: agent-ndjson-export
spec_content_hash: 5924933b8cce442b0f1706027cc9d337dce8ed864b486fc8ea88096ca054f38a
---

## Files

- `src/agent/ndjson-export.ac1.test.ts` — the tests for AC-1
- `src/agent/ndjson-export.ac2.test.ts` — the tests for AC-2
- `src/agent/ndjson-export.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/agent/ndjson-export.ac1.test.ts` | src/agent/index.ts#createNdjsonExporter(destination: Writable, options?: { queueBound?: number }): NdjsonExporter — export(record: unknown): void; stop(): Promise<void>; readonly done: Promise<void> — three plain objects exported to a recording Writable, then stop()
- AC-2 | unit | `src/agent/ndjson-export.ac2.test.ts` | src/agent/index.ts#createNdjsonExporter(destination: Writable, { queueBound: N }): NdjsonExporter — export(record: unknown): void; readonly dropped: number; stop(): Promise<void> — a Writable whose write() returns false and withholds 'drain' until resumed, counting accepted records in its own write path
- AC-3 | integration | `src/agent/ndjson-export.ac3.integration.test.ts` | src/agent/index.ts#createSamplerController((sample) => exporter.export(sample)).start(intervalMs) with createNdjsonExporter(destination) — destination emits an error after a few intervals; exporter.done rejects with that same error and the destination receives no further write
