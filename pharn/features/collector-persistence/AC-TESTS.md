---
spec_id: collector-persistence
spec_content_hash: aef97b4dab00e2f56a841bb6563e872e960151d45a44755be5f2dfc4d71914a0
---

## Files

- `src/collector/collector-persistence.ac1.integration.test.ts` — the tests for AC-1
- `src/collector/collector-persistence.ac2.integration.test.ts` — the tests for AC-2
- `src/collector/collector-persistence.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/collector/collector-persistence.ac1.integration.test.ts` | src/collector/index.ts#createCollector(options: { windowMs: number; capacity: number; persist?: { path: string; maxBytes: number } }): Collector — consume(source: Readable | AsyncIterable<AgentSample>): Promise<void>; windows.snapshot(): AggregatedWindow[]; two collectors (windowMs 1000, capacity 10), one with persist.path inside fs.mkdtemp(os.tmpdir()) and a large maxBytes, one with no persist option and its own empty temp dir, each consuming a Readable.from source spanning windows 0/1000/2000; observed via fs.readFile lines parsed as JSON compared to windows.snapshot() in order, and fs.readdir of the no-persist temp dir being empty
- AC-2 | integration | `src/collector/collector-persistence.ac2.integration.test.ts` | src/collector/index.ts#createCollector(options: { windowMs: number; capacity: number; persist?: { path: string; maxBytes: number } }): Collector — persistence: { skipped: number; restored: number; bytes: number; path: string; maxBytes: number } | undefined; a file pre-written with twelve valid AggregatedWindow NDJSON lines, one non-JSON line between them and a truncated partial last line with no trailing newline; capacity 10, then consume(Readable.from(samples spanning two later windows)); observed via no throw, persistence.skipped === 2, and windows.snapshot() equal to the last eight restored windows followed by the two new windows
- AC-3 | integration | `src/collector/collector-persistence.ac3.integration.test.ts` | src/collector/index.ts#createCollector(options: { windowMs: number; capacity: number; persist?: { path: string; maxBytes: number } }): Collector — capacity 3 and a small maxBytes with a source spanning enough windows to exceed it, observed via fs.readFile lines (all JSON, a contiguous in-order run of the consumed windows ending with the last closed window, fewer lines than windows consumed) and fs.readdir showing only the persisted file; persist.path set to a directory, observed via consume() rejecting; and synchronous throws from createCollector for persist.maxBytes 0, persist.maxBytes -1 and persist.path '', each message containing maxBytes or path respectively
