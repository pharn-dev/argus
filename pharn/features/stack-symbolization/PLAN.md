---
spec_id: stack-symbolization
spec_content_hash: d83148099884b06c86741bfbfdcad9d356f6144739ab2810aa704694c1dea82a
applied_lessons: none
---

## Approach

> ADVISORY: model work, derived from the Approved SPEC `stack-symbolization` (`spec_kind: quick`, ROADMAP S5,
> stack symbolization slice).

Discovery (live, this run): `src/analyzer/` already has a generic worker pool (`worker-pool.ts`,
`createWorkerPool({ size, workerFile, taskTimeoutMs?, resourceLimits? })`, `run(payload, { timeoutMs? })`, `close()`;
`run` on a closed pool returns `Promise.reject(new WorkerPoolClosedError())`), typed pool errors with stable `name` and
`code` (`worker-errors.ts`), the worker message protocol (`worker-protocol.ts`), and `resolveBundledWorkerFile(baseName)`
(`worker-file.ts`), which finds `workers/<baseName>.js` in builds and `workers/<baseName>.ts` in source (vitest loads
worker `.ts` files through Node type stripping, so worker files must use erasable TypeScript only). `heap-snapshot.ts`
plus `workers/heap-snapshot.worker.ts` is the pattern to mirror: a `create…Pool()` factory, an optional caller `pool`
(a private pool is created and closed per call otherwise), argument checks in an `async function` so every failure is a
rejection, and a reply shape guard. `scripts/build.mjs` compiles all of `src/**/*.ts` (minus tests) with `tsc` into
both `dist/esm` and `dist/cjs`, so a new worker file under `src/analyzer/workers/` is bundled in both formats without
any build change.

Node core `node:module` `SourceMap` (probed live on Node 22.19.0): the constructor throws a `TypeError` on a payload
that is not a usable v3 map (`null`, or an object without `sources`/`mappings`); `findEntry(line0, column0)` takes
0-based positions and returns the nearest mapping at or before the position (possibly from an earlier line), or `{}`
before the first mapping; `originalSource` is returned raw — `sourceRoot` is **not** applied, so the worker applies it.

1. **Public types and API** (`src/analyzer/stack-symbolization.ts`, new):
   - `export type StackFrame = { url: string; line: number; column: number }` — `url` is a `file:` URL (an absolute
     path is also accepted, SPEC assumption); `line`/`column` are 1-based integers as printed in Node stack traces.
   - `export type OriginalPosition = { url: string; line: number; column: number }` — `url` is the original source
     resolved to an absolute URL (a `file:` URL for local sources), 1-based `line`/`column`.
   - `export type SymbolizedFrame = StackFrame & { original?: OriginalPosition; error?: MalformedSourceMapError }`.
     A mapped frame is a shallow copy of the input plus `original`; a malformed-map frame is a shallow copy of the input
     plus `error`; an unchanged frame is a shallow copy of the input with nothing added (so it is deeply equal to the
     input, AC-1).
   - `export function createSymbolizationPool(options: { size?: number; taskTimeoutMs?: number; resourceLimits?: ResourceLimits } = {}): WorkerPool`
     — `createWorkerPool` with `workerFile: resolveBundledWorkerFile('symbolize.worker')`, `size` default 1, optional
     fields spread only when defined (`exactOptionalPropertyTypes`), exactly as `createHeapSnapshotPool`.
   - `export async function symbolizeStackFrames(frames: readonly StackFrame[], options: { pool?: WorkerPool; timeoutMs?: number } = {}): Promise<SymbolizedFrame[]>`.
     Being an `async function`, every throw in its body is a rejection, never a synchronous throw (AC-3). Order:
     1. `if (!Array.isArray(frames)) throw new TypeError('frames must be an array')`; each element must be an object
        with a string `url` and positive safe-integer `line` and `column`, else `TypeError` naming the index.
     2. Build the payload `{ frames: frames.map(({ url, line, column }) => ({ url, line, column })) }` (only the three
        fields cross the thread boundary).
     3. **Always** dispatch through the pool, even for an empty list or a list with no `file:` frames, so the given
        pool is always the route (AC-3): `pool = options.pool ?? createSymbolizationPool()`, `await pool.run(payload,
        timeoutMs?)`, and close the private pool in `finally` (the heap-snapshot `runTask` shape). Pool rejections
        (`WorkerPoolClosedError`, `WorkerTaskTimeoutError`, `WorkerCrashedError`, `WorkerTaskError`) propagate
        unchanged — no swallowing.
     4. Validate the reply with a local guard: an array of the same length whose items are
        `{ status: 'unchanged' } | { status: 'mapped'; url: string; line: int; column: int } | { status: 'malformed'; file: string; reason: string }`;
        otherwise throw `new Error('symbolization worker returned an unexpected reply')`.
     5. Compose in input order: `unchanged` → `{ ...frames[i] }`; `mapped` → `{ ...frames[i], original: { url, line, column } }`;
        `malformed` → `{ ...frames[i], error: new MalformedSourceMapError(file, reason) }`. One `MalformedSourceMapError`
        instance per malformed file is shared by that file's frames. The typed error is built on the main thread because
        structured clone across the worker boundary drops a custom class and its `code`.
2. **Typed error** (`src/analyzer/source-map-error.ts`, new): `export class MalformedSourceMapError extends Error` with
   `readonly code = 'ERR_MALFORMED_SOURCE_MAP'`, `readonly file: string` (the built file's path), `name =
   'MalformedSourceMapError'`, message `malformed source map for <file>: <reason>` — so the message names the built
   file (AC-2). Kept apart from `worker-errors.ts`, whose single reason to change is the pool's rejections (P3).
3. **Worker** (`src/analyzer/workers/symbolize.worker.ts`, new; Node core only, erasable TypeScript only, a real file —
   never inline or `eval`): imports `node:fs/promises`, `node:module` (`SourceMap`), `node:path`, `node:url`,
   `node:worker_threads`, and `import type` from `../worker-protocol.js` and `../symbolize-protocol.js`. The message
   handler, `serialize(error)` and the `.then/.catch` reply chain mirror `heap-snapshot.worker.ts`.
   - Validates the payload shape (an object with a `frames` array of `{ url: string, line: int, column: int }`) and
     throws on a bad shape (surfaces as `WorkerTaskError`, never silent).
   - For each frame, decides the built file: `url` starting with `file:` → `fileURLToPath(url)`; an absolute path →
     itself; anything else (`node:`, `native`, `<anonymous>`, `http:` …) → `unchanged`, no read (SPEC non-goal +
     assumption).
   - Groups frames by built file and loads each file's map once per call (no cross-call cache, SPEC non-goal):
     - `readFile(file, 'utf8')` fails → the file's frames are `unchanged` (SPEC assumption: unreadable = no map).
     - Find the last `//# sourceMappingURL=<value>` (also the legacy `//@` form) comment in the file text with a
       line-anchored regex; none → `unchanged`.
     - `<value>` starting with `data:` → must be a JSON `data:` URL with `;base64,`; decode with
       `Buffer.from(payload, 'base64').toString('utf8')`; the map's base URL is the built file's URL. A `data:` URL
       that is not base64 → `malformed` (a map was found but cannot be parsed).
     - Otherwise resolve `<value>` against the built file's `file:` URL; a non-`file:` result (e.g. `http:`) →
       `unchanged` (no fetching, SPEC non-goal); `readFile` of the map fails → `unchanged` (no readable map); the map's
       base URL is the map file's URL.
     - `JSON.parse` throws, the parsed value is not an object, or `new SourceMap(parsed)` throws → every frame of that
       file is `{ status: 'malformed', file, reason }` with the parse error's message as `reason`; other files in the
       same call are still processed (AC-2).
   - Per covered frame: `entry = map.findEntry(line - 1, column - 1)`. The frame is covered only when
     `typeof entry.originalSource === 'string'` and `entry.generatedLine === line - 1` (a position on a line the map has
     no mapping for is returned unchanged, SPEC scope); else `unchanged`. Covered →
     `{ status: 'mapped', url: new URL((sourceRoot ?? '') + originalSource, baseUrl).href, line: entry.originalLine + 1, column: entry.originalColumn + (column - 1 - entry.generatedColumn) + 1 }`
     — all integer arithmetic. `sourceRoot` is applied with a `/` separator when it lacks one; an absolute
     `originalSource` URL is kept as is by `new URL`.
   - Replies with the per-frame result array, in input order.
4. **Protocol types** (`src/analyzer/symbolize-protocol.ts`, new, types only): `SymbolizeRequest` and the per-frame
   `SymbolizeResult` union shared by the main-thread guard and the worker, so the two cannot drift (mirrors
   `worker-protocol.ts`).
5. **Entrypoint** (`src/analyzer/index.ts`, modified): add
   `export { createSymbolizationPool, symbolizeStackFrames } from './stack-symbolization.js';`,
   `export type { OriginalPosition, StackFrame, SymbolizedFrame } from './stack-symbolization.js';`,
   `export { MalformedSourceMapError } from './source-map-error.js';`. `WorkerPoolClosedError` is already exported.
   Nothing removed.

Constraints held by construction: no dependency added (`node:module` `SourceMap`); `src/agent` untouched; mapping runs
only in `workers/symbolize.worker.ts` through the analyzer pool; every failure is either a typed per-file error or a
rejection; positions in and out are 1-based integers; no build, config or test-infra change.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there are no
  lessons to apply.

## Steps

- Add `src/analyzer/source-map-error.ts` with `MalformedSourceMapError`.
- Add `src/analyzer/symbolize-protocol.ts` with the request and per-frame result types.
- Add `src/analyzer/workers/symbolize.worker.ts` per Approach step 3.
- Add `src/analyzer/stack-symbolization.ts` with the types, `createSymbolizationPool` and `symbolizeStackFrames` per
  Approach step 1.
- Add the re-export lines to `src/analyzer/index.ts`.
- Run `npx prettier --write` on each touched file, then `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run build` and `npm run check:exports`; confirm `dist/esm/analyzer/workers/symbolize.worker.js` and
  `dist/cjs/analyzer/workers/symbolize.worker.js` exist.

## Files

- `src/analyzer/stack-symbolization.ts` — new: `StackFrame`, `OriginalPosition`, `SymbolizedFrame`, `createSymbolizationPool()`, `symbolizeStackFrames(frames, { pool?, timeoutMs? })` with input checks, pool dispatch, reply guard and result composition
- `src/analyzer/source-map-error.ts` — new: `MalformedSourceMapError` (`name`, `code: 'ERR_MALFORMED_SOURCE_MAP'`, `file`, message naming the built file)
- `src/analyzer/symbolize-protocol.ts` — new: types-only request and per-frame result shapes shared by the API and the worker
- `src/analyzer/workers/symbolize.worker.ts` — new: reads built files, finds inline or adjacent source maps, parses them with `node:module` `SourceMap`, maps covered frames, reports malformed maps per file
- `src/analyzer/index.ts` — modified: re-exports `symbolizeStackFrames`, `createSymbolizationPool`, `MalformedSourceMapError` and the frame types

### Explicitly not touched

- `src/analyzer/worker-pool.ts`, `src/analyzer/worker-errors.ts`, `src/analyzer/worker-protocol.ts`, `src/analyzer/worker-file.ts` — reused as is.
- `src/analyzer/heap-snapshot.ts`, `src/analyzer/workers/heap-snapshot.worker.ts` — the pattern mirrored; unchanged.
- `src/agent/**` — SPEC constraint: the agent gains nothing.
- `package.json`, `vitest.config.mts`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`, `eslint.config.mjs`, `scripts/build.mjs`, `scripts/check-exports.mjs` — test and build infrastructure, out of scope.

## Acceptance mapping

- **AC-1** (adjacent `.map` fixture, inline base64 `data:` fixture, a no-map file and a `node:internal` frame; one
  output per input in order; mapped frames carry the fixture maps' original file, line, column; the rest deeply equal
  the input; integration) → the worker resolves the adjacent map against the built file URL and decodes the inline
  base64 map; `findEntry` on the same generated line gives the original line/column, `+1` for 1-based; the original
  source is resolved to an absolute URL against the map's base and exposed as `frame.original`; the no-map file and
  the non-`file:` frame come back `unchanged` and are composed as `{ ...input }`.
- **AC-2** (invalid-JSON adjacent map plus a valid one; the call resolves; the valid frame is mapped; the malformed
  frame keeps file/line/column and carries an error with identifying `name`/`code` and a message naming the file;
  integration) → `JSON.parse` failure is caught per file and returned as `malformed`; the main thread attaches a
  `MalformedSourceMapError` (`name 'MalformedSourceMapError'`, `code 'ERR_MALFORMED_SOURCE_MAP'`, message
  `malformed source map for <built file path>: …`) to that file's frames only; other files are processed normally.
- **AC-3** (a closed symbolization pool passed as `pool` → rejects with `WorkerPoolClosedError`; a non-array `frames`
  → rejects with `TypeError`; neither throws synchronously; integration) → `symbolizeStackFrames` is an `async
  function`; input checks throw `TypeError` inside it; the call always dispatches through `options.pool`, whose `run`
  rejects with `WorkerPoolClosedError` once closed.

## Risks & open questions

- **Coverage rule.** `findEntry` returns the nearest preceding mapping, possibly on an earlier line; this plan treats a
  frame as covered only when that mapping is on the same generated line, and offsets the column within the segment as
  Node's own `findOrigin` does. AC fixtures should place frames exactly on mapping starts, where both rules agree.
- **Missing adjacent `.map`.** A `sourceMappingURL` naming a `.map` file that cannot be read is treated as "no source
  map" (frames unchanged), by extension of the SPEC's unreadable-file assumption; only a map that is read but cannot be
  parsed is `malformed`. A non-base64 `data:` URL is `malformed`. Flagged for `/pharn-grill`.
- **Original URL shape.** `original.url` is an absolute URL (`file:` for local sources), resolved from the map's
  `sourceRoot` + `sources[i]` against the map file's URL (adjacent) or the built file's URL (inline). Tests should
  build the expected value with `pathToFileURL(...).href`. On macOS a temp dir under a symlinked `/var` stays as given
  (no `realpath`), so `pathToFileURL(mkdtemp result)` matches.
- **Field and name choices** (`symbolizeStackFrames`, `StackFrame { url, line, column }`, `original`, `error`,
  `MalformedSourceMapError`, `ERR_MALFORMED_SOURCE_MAP`, `createSymbolizationPool`) are this plan's choices where the
  SPEC left them open; they are reachable from `src/analyzer/index.ts` (and `argus/analyzer`).
- **Worker source loading under vitest.** The worker `.ts` file is loaded by Node type stripping; it must use only
  erasable syntax (no enums, no parameter properties, `import type` for types), as `heap-snapshot.worker.ts` does.
- **Fixtures.** AC tests should write their fixture `.js`/`.map` files into an `mkdtemp` directory at test time, so no
  fixture file enters `src/` (where `tsc`, ESLint and Prettier would see it).
