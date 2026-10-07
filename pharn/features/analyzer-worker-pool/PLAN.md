---
spec_id: analyzer-worker-pool
spec_content_hash: 438827a9fd0efb534bd1a51e0fb22f6a7d0bf85c0c5af1ab4853b1569049722f
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `analyzer-worker-pool` (ROADMAP S5, analyzer
> slice 1).

Discovery (live, this run): single npm package (`"type": "module"`, `engines.node >=22`, `.nvmrc` = `22`, CI uses
`node-version-file: .nvmrc`; local Node is v24.13.1), dual build by `scripts/build.mjs` (tsc `tsconfig.esm.json` →
`dist/esm`, module NodeNext; tsc `tsconfig.cjs.json` → `dist/cjs`, module CommonJS; each with a `package.json`
pinning its `type`). Both build configs compile `src/**/*.ts` minus `src/**/*.test.ts`, so files under
`src/analyzer/workers/` are emitted as `dist/{esm,cjs}/analyzer/workers/*.js`. `tsconfig.base.json` is strict with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. vitest 5.0.3, `include: ['src/**/*.test.ts']`.
`src/analyzer/index.ts` is a placeholder (`export type AnalyzerPlaceholder = void`) and `src/analyzer/index.test.ts`
only checks that the entrypoint loads. Nothing in `src/` uses `node:worker_threads` yet.

A probe run this session in the scratchpad (not in the repo) measured two facts the design rests on: under vitest
5.0.3 a module's `__dirname` is defined and points at the source directory, and `new Worker(<file URL of a .ts
file>)` loads that file through Node's built-in type stripping when the worker file imports only `node:` builtins.
The CommonJS build cannot contain `import.meta` (it is a syntax error in CJS output), so the analyzer locates its
own directory without it (see 3 below).

Design (each file one axis of change; Node core only; no imports from `src/agent` or any other module):

1. **Worker message protocol** (`src/analyzer/worker-protocol.ts`, new) — types and one guard, no I/O.
   - `TaskRequest = { id: number; payload: unknown }` (pool → worker).
   - `TaskReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: SerializedError }`
     (worker → pool), `SerializedError = { name: string; message: string; stack?: string }`.
   - `isTaskReply(value: unknown): value is TaskReply` — structural membership check (object, integer `id`, boolean
     `ok`, `error.name`/`error.message` strings when `ok` is false).
   - Worker files reach these types with `import type` only, which Node's type stripping erases, so a worker never
     needs a runtime relative import (a `.js` specifier does not exist next to a `.ts` source under vitest).
2. **Errors** (`src/analyzer/worker-errors.ts`, new) — the error classes the pool rejects with, each with a stable
   `name` and a `code` string:
   - `WorkerPoolClosedError` (`ERR_WORKER_POOL_CLOSED`) — `run()` after `close()`, and every queued or in-flight
     task at `close()`.
   - `WorkerTaskTimeoutError` (`ERR_WORKER_TASK_TIMEOUT`, `timeoutMs` field) — message `worker task timed out after
     <n> ms`.
   - `WorkerCrashedError` (`ERR_WORKER_CRASHED`) — the worker emitted `error` or exited while running a task; the
     worker's error is the `cause`, and its message is included in this error's message.
   - `WorkerTaskError` (`ERR_WORKER_TASK_FAILED`) — the worker replied `ok: false`; `name`/`message`/`stack` of the
     serialized error are carried on it (`remoteName`, message, `remoteStack`).
   - `WorkerQueueFullError` (`ERR_WORKER_QUEUE_FULL`, extends `RangeError`) — `run()` when the queue is at its bound.
3. **Bundled worker file resolution** (`src/analyzer/worker-file.ts`, new) —
   `resolveBundledWorkerFile(baseName: string): string`.
   - Module directory: `typeof __dirname === 'string'` → `__dirname` (the CJS build, and vitest, which defines it
     for source files). Otherwise (the ESM build) read this function's own call site through the structured V8
     stack API: set `Error.prepareStackTrace = (_, sites) => sites` and a sufficient `Error.stackTraceLimit`
     temporarily, capture, restore both in `finally`, take `sites[0].getFileName()`, and convert a `file:` URL with
     `fileURLToPath`. A missing or unusable file name throws an `Error` saying the analyzer could not locate its
     worker directory — never a guess.
   - Candidates: `<dir>/workers/<baseName>.js` (both builds), then `<dir>/workers/<baseName>.ts` (source under
     vitest; the builds ship no `.ts`, only `.d.ts`). First that `existsSync` wins; none → `Error` listing the paths
     tried.
4. **Worker pool** (`src/analyzer/worker-pool.ts`, new) —
   `createWorkerPool(options: WorkerPoolOptions): WorkerPool` with
   `WorkerPoolOptions = { size: number; workerFile: string | URL; maxQueue?: number; taskTimeoutMs?: number;
   resourceLimits?: ResourceLimits }` and
   `WorkerPool = { readonly size: number; readonly closed: boolean; run<T = unknown>(payload: unknown, options?: {
   timeoutMs?: number }): Promise<T>; close(): Promise<void> }`.
   - Validation at construction (synchronous `TypeError`/`RangeError`): `size` and `maxQueue` positive safe integers,
     `taskTimeoutMs` positive safe integer, `workerFile` a non-empty string or a `URL`. Per-run `timeoutMs` is
     validated the same way and rejects the returned promise (never throws synchronously).
   - Defaults (finite): `maxQueue` 1024, `taskTimeoutMs` 30000.
   - `size` slots, each `{ worker: Worker | undefined; task: ActiveTask | undefined }`. Workers are spawned
     **lazily** when a task is dispatched to an empty slot, so a broken worker file fails the task that needed it
     instead of looping on respawn, and "replaced" means a fresh `Worker` on the next dispatch.
   - `run()`: closed → reject `WorkerPoolClosedError`; queue length `>= maxQueue` → reject `WorkerQueueFullError`;
     otherwise enqueue `{ id, payload, timeoutMs, resolve, reject }` (integer `id` from a `+= 1` counter) and call
     `dispatch()`.
   - `dispatch()`: while an idle slot and a queued task exist, shift the task, spawn the slot's worker if needed
     (a synchronous `new Worker` throw rejects that task with the thrown error and leaves the slot empty), `ref()`
     the worker, start the task timer, `postMessage({ id, payload })` (a throw — e.g. an uncloneable payload —
     rejects that task and keeps the worker).
   - Listeners attached once per worker at spawn: `message` → if `isTaskReply` and `id` matches the slot's task,
     settle it (`ok` → resolve `value`; else reject `WorkerTaskError`); a reply that fails the guard or names
     another id rejects the active task with a `WorkerCrashedError` and retires the worker. `error` → reject the
     active task with `WorkerCrashedError(cause)` and retire the slot's worker. `exit` → if the slot still holds this
     worker with an active task, reject it with `WorkerCrashedError` naming the exit code; clear the slot. After any
     settle: clear the timer, `unref()` the idle worker (a forgotten pool never holds the process open), and
     `dispatch()` again.
   - Timeout: the timer rejects the task with `WorkerTaskTimeoutError`, retires the worker (`terminate()`), and
     dispatches. Retiring = detach the slot first (so the later `exit` event of that worker is ignored), then
     `worker.terminate().catch(...)` where a terminate failure is surfaced with `process.emitWarning` — never
     swallowed, never an unhandled rejection.
   - A task is settled at most once (a `settled` flag on the active task); every timer is cleared on settle.
   - `close()`: idempotent (returns the same promise on repeat calls); sets `closed`; rejects every queued task and
     every in-flight task with `WorkerPoolClosedError`; terminates every worker and awaits
     `Promise.allSettled` of the terminations; a failed termination is reported with `process.emitWarning`;
     `close()` itself always resolves.
5. **Heap-snapshot worker** (`src/analyzer/workers/heap-snapshot.worker.ts`, new) — the only place snapshots are
   parsed. Imports `node:worker_threads` and `node:fs/promises` at runtime and `import type` from
   `../worker-protocol.js`; erasable TypeScript only (no enums, namespaces or parameter properties) so type
   stripping can load the source under vitest.
   - On `message`: validate the `TaskRequest`; payload `{ kind: 'summary'; path: string; top: number }` or
     `{ kind: 'diff'; beforePath: string; afterPath: string; top: number }` (kind checked by membership in that
     closed set). Every failure — unknown kind, bad field, file read error (message names the path), JSON parse
     error, invalid snapshot shape — is caught and replied as `ok: false` with the serialized error. The handler is
     an `async` function whose returned promise is explicitly `.catch`-ed into a reply, so nothing is unhandled.
   - `aggregate(snapshot)`: require `snapshot.meta.node_fields` (string array containing `type`, `name`,
     `self_size`), `snapshot.meta.node_types[0]` (string array of type names), `nodes` (array whose length is a
     multiple of `node_fields.length`) and `strings` (string array). Walk `nodes` with integer stride; the group name
     is `strings[name]` for type `object` and `native`, otherwise `(<type name>)` (the DevTools "constructor"
     grouping). Accumulate `Map<name, { count, selfSize }>` plus `nodeCount` and `totalSelfSize`; every field read
     is checked with `Number.isSafeInteger` (an invalid value is an invalid-snapshot error), sums stay integers.
   - Summary reply: `{ nodeCount, totalSelfSize, top: Array<{ name, count, selfSize }> }`, `top` sorted by
     `selfSize` descending, ties by `name` ascending, sliced to `top`.
   - Diff reply: aggregate both files (sequentially, releasing the first parse before the second), union of names,
     `entries: Array<{ name, countDelta, selfSizeDelta }>` sorted by `selfSizeDelta` descending, ties by `name`,
     sliced to `top`; plus `before` and `after` `{ nodeCount, totalSelfSize }`.
6. **Heap-snapshot API** (`src/analyzer/heap-snapshot.ts`, new) — the caller-side face of the tasks:
   - `createHeapSnapshotPool(options?: { size?: number; taskTimeoutMs?: number; resourceLimits?: ResourceLimits }):
     WorkerPool` — `createWorkerPool` over `resolveBundledWorkerFile('heap-snapshot.worker')`, default size 1.
   - `summarizeHeapSnapshot(path: string, options?: { top?: number; pool?: WorkerPool; timeoutMs?: number }):
     Promise<HeapSnapshotSummary>` and `diffHeapSnapshots(beforePath: string, afterPath: string, options?: { top?:
     number; pool?: WorkerPool; timeoutMs?: number }): Promise<HeapSnapshotDiff>`.
   - Validation rejects the returned promise: paths non-empty strings, `top` a positive safe integer (default 20).
     Paths are resolved with `path.resolve` before they cross to the worker.
   - Without `pool`, each call creates a size-1 heap pool and closes it in `finally` (close never rejects, so the
     task's own outcome is what the caller sees). With `pool`, it is used and left open.
   - Result types `HeapSnapshotSummary`, `HeapSnapshotTypeStats`, `HeapSnapshotDiff`, `HeapSnapshotDiffEntry`
     exported; the worker's reply is shape-checked before it is returned (a mismatch rejects with an `Error`).
7. **Test worker fixture** (`src/analyzer/workers/test-task.worker.ts`, new, written by the build because
   `/pharn-test` may write only mapped test files) — a worker that speaks the protocol: payload `{ kind: 'echo' }`
   (any extra fields) → replies `ok: true` with the payload unchanged; `{ kind: 'crash' }` → `throw new
   Error('test-task worker: crash requested')` from the message handler (an uncaught worker error, so the pool
   sees `error` then `exit`); `{ kind: 'hang' }` → never replies (the `parentPort` listener keeps the worker
   alive); any other kind → `ok: false` reply. Node core only, `import type` only from the protocol.
8. **Entrypoint** (`src/analyzer/index.ts`, modified) — drop the placeholder; re-export `createWorkerPool`,
   `WorkerPool`, `WorkerPoolOptions`, the five error classes, `createHeapSnapshotPool`, `summarizeHeapSnapshot`,
   `diffHeapSnapshots` and the result types. Importing the entrypoint spawns nothing, so `check:exports` and the
   existing `src/analyzer/index.test.ts` keep passing.

## Applied lessons

- none — `check-lessons-index.mjs --verdict` printed `NO_CANON`: this project has no `memory-bank/lessons-learned.md`
  yet, so there are no promoted lessons to apply.

## Steps

- Write `worker-protocol.ts` and `worker-errors.ts` (no behaviour beyond the guard and the error constructors).
- Write `worker-file.ts`; check by hand that `npm run build` then `node -e` importing `dist/esm/analyzer/index.js`
  and `require`-ing `dist/cjs/analyzer/index.js` both resolve `.../dist/<fmt>/analyzer/workers/heap-snapshot.worker.js`.
- Write `worker-pool.ts` with lazy spawn, per-task timer, retire-on-crash/timeout, idempotent `close()`.
- Write `workers/test-task.worker.ts` and `workers/heap-snapshot.worker.ts` with erasable syntax only.
- Write `heap-snapshot.ts`, then replace `index.ts`'s placeholder with the re-exports.
- Run `npx prettier --write` on every new or edited file, then `npm run typecheck`, `npm run lint`,
  `npm run format:check`, `npm test`, `npm run build`, `npm run check:exports`.

## Files

- `src/analyzer/worker-protocol.ts` — new. `TaskRequest`, `TaskReply`, `SerializedError` and `isTaskReply`.
- `src/analyzer/worker-errors.ts` — new. `WorkerPoolClosedError`, `WorkerTaskTimeoutError`, `WorkerCrashedError`,
  `WorkerTaskError`, `WorkerQueueFullError`, each with a stable `name` and `code`.
- `src/analyzer/worker-file.ts` — new. `resolveBundledWorkerFile`: module directory via `__dirname` or the V8 call
  site, `.js` then `.ts` candidate under `workers/`.
- `src/analyzer/worker-pool.ts` — new. `createWorkerPool`: fixed-size lazy-spawn pool, bounded queue, per-task
  timeout, crash and timeout replacement, idempotent `close()`.
- `src/analyzer/heap-snapshot.ts` — new. `createHeapSnapshotPool`, `summarizeHeapSnapshot`, `diffHeapSnapshots` and
  the result types.
- `src/analyzer/workers/heap-snapshot.worker.ts` — new. Reads and parses a `.heapsnapshot` file and returns the
  integer summary or diff.
- `src/analyzer/workers/test-task.worker.ts` — new. Test fixture worker: echo, crash or hang on demand.
- `src/analyzer/index.ts` — modified. Placeholder replaced by the public re-exports.

### Explicitly not touched

- `src/analyzer/index.test.ts` — existing test; it must keep passing unchanged.
- `src/agent/**`, `src/collector/**`, `src/dashboard/**`, `src/plugin-runner/**` — out of scope per the SPEC.
- `vitest.config.mts`, `package.json`, `tsconfig.json`, `tsconfig.base.json`, `tsconfig.esm.json`,
  `tsconfig.cjs.json`, `eslint.config.mjs`, `scripts/build.mjs`, `scripts/check-exports.mjs` — test and build
  infrastructure, out of scope.
- `examples/worker-pool/` — a SPEC non-goal.

## Acceptance mapping

- AC-1 (pool echo / crash / timeout / replace / close) → `createWorkerPool({ size: 1, workerFile: <URL of
  src/analyzer/workers/test-task.worker.ts> })`: echo resolves with the payload (7), crash rejects with
  `WorkerCrashedError` from the `error` listener and empties the slot (4), `run({ kind: 'hang' }, { timeoutMs })`
  rejects with `WorkerTaskTimeoutError` after the timer terminates the worker (4), the next echo spawns a fresh
  worker lazily and resolves (4), and tasks queued behind a busy or freshly dispatched slot reject with
  `WorkerPoolClosedError` on `close()`; every rejection is the caller's promise and internal `terminate()` promises
  are caught, so no unhandled rejection (4).
- AC-2 (summary) → `summarizeHeapSnapshot(path, { top: 50 })` runs the `summary` task in the heap worker (5, 6):
  integer `nodeCount` and `totalSelfSize`, `top` sorted by `selfSize` descending, at most 50, and the class's
  instances grouped under its constructor name (type `object` → `strings[name]`), count ≥ 10000.
- AC-3 (diff) → `diffHeapSnapshots(before, after, { top: 20 })` (5, 6): union of names, integer deltas, sorted by
  `selfSizeDelta` descending, at most 20; a class absent from the first snapshot and holding 5000 instances in the
  second has `countDelta ≥ 5000` and a positive `selfSizeDelta`, and with 5000 instances of non-trivial size it
  ranks inside the top 20.

## Risks & open questions

- **ESM directory lookup uses the V8 call-site API** (`Error.prepareStackTrace`), because `import.meta` cannot
  appear in the CommonJS build. It is restored in `finally` and fails loudly; the manual `node -e` check in Steps
  covers both builds, since `check:exports` only loads the entrypoint and never spawns the worker.
- **Type stripping under Node 22.** Loading a `.ts` worker under vitest needs Node's type stripping, on by default
  from Node 22.18; CI resolves `.nvmrc` `22` to the latest 22.x. On an older 22.x the AC tests would fail at worker
  load with a clear error. Worker files must stay erasable-only and import only `node:` builtins at runtime.
- **The test fixture ships in `dist/`.** `test-task.worker.ts` lives under `src/analyzer/workers/` as the SPEC
  requires and both build configs compile it; it is inert unless a caller points a pool at it.
- **AC-3 ranking.** The diff test's class must grow self size enough to rank in the top 20 by `selfSizeDelta`;
  background growth between two snapshots of the test process (strings, code) competes. Instances with a few own
  fields (or a small array each) keep the class's delta well above that noise; this is the test author's choice.
- **Memory.** Whole-file `JSON.parse` in the worker is the SPEC's bound (streaming is a non-goal); the optional
  `resourceLimits` passthrough lets a caller cap the worker's heap.
