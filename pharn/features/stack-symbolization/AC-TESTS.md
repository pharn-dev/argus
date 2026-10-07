---
spec_id: stack-symbolization
spec_content_hash: d83148099884b06c86741bfbfdcad9d356f6144739ab2810aa704694c1dea82a
---

## Files

- `src/analyzer/stack-symbolization.ac1.integration.test.ts` — the tests for AC-1
- `src/analyzer/stack-symbolization.ac2.integration.test.ts` — the tests for AC-2
- `src/analyzer/stack-symbolization.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/analyzer/stack-symbolization.ac1.integration.test.ts` | src/analyzer/index.ts#symbolizeStackFrames(frames: readonly { url: string; line: number; column: number }[], options?: { pool?: WorkerPool; timeoutMs?: number }): Promise<Array<{ url: string; line: number; column: number; original?: { url: string; line: number; column: number }; error?: MalformedSourceMapError }>> — driven in-process (vitest, imported from ./index.js) through a real analyzer worker; fixtures written at test time into an mkdtemp directory: a built .js file with a `//# sourceMappingURL=<name>.map` comment and an adjacent hand-written v3 .map, a built .js file with an inline `data:application/json;base64,` map, and a .js file with no map; frames are pathToFileURL(file).href with 1-based line/column on mapping starts, plus a `node:internal/...` frame; expects same length and order, `original` equal to { url: pathToFileURL(resolved fixture source).href, line, column } from the fixture maps, and the no-map and node:internal outputs toEqual their inputs; temp dir removed after
- AC-2 | integration | `src/analyzer/stack-symbolization.ac2.integration.test.ts` | src/analyzer/index.ts#symbolizeStackFrames(frames, options?) and src/analyzer/index.ts#MalformedSourceMapError — driven in-process (vitest, imported from ./index.js); mkdtemp fixtures: one built .js whose adjacent .map contains invalid JSON and one built .js with a valid adjacent map; the awaited call resolves; the valid frame carries `original`; the malformed-map frame keeps the input url, line and column and carries `error` that is an instance of MalformedSourceMapError with name 'MalformedSourceMapError', code 'ERR_MALFORMED_SOURCE_MAP' and a message containing the built file's path; temp dir removed after
- AC-3 | integration | `src/analyzer/stack-symbolization.ac3.integration.test.ts` | src/analyzer/index.ts#createSymbolizationPool(options?: { size?: number; taskTimeoutMs?: number }): WorkerPool, src/analyzer/index.ts#symbolizeStackFrames(frames, options?: { pool?: WorkerPool }) and src/analyzer/index.ts#WorkerPoolClosedError — driven in-process (vitest, imported from ./index.js): a pool is created with createSymbolizationPool() and awaited close(); symbolizeStackFrames([{ url: file URL, line: 1, column: 1 }], { pool }) is called inside a try that records any synchronous throw and rejects with WorkerPoolClosedError; symbolizeStackFrames('not an array' as never) likewise does not throw synchronously and rejects with TypeError
