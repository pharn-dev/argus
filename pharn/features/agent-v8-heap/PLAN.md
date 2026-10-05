---
spec_id: agent-v8-heap
spec_content_hash: 578bb8916e3b3de896ebbb5850bd5da168b7b3ca12a7680f0de3115457a99896
applied_lessons: none
---

## Approach

> ADVISORY: model work, derived from the Approved SPEC `agent-v8-heap` (`spec_kind: quick`, ROADMAP S5 slice 1).

Discovery (live, this run): the agent is `src/agent/` of a single npm package. `src/agent/index.ts` is the
side-effect-free library entry (`src/agent/auto.ts` re-exports it and starts the agent, so anything exported from
`index.ts` is also reachable from `argus/agent`). `src/agent/sampler-controller.ts` builds
`AgentSample = { timestamp, eventLoop, memory, gc, backpressure }` on each unref'd `setInterval` tick; it is the
only code that builds an `AgentSample` literal. The collector (`src/collector/window.ts`, `window-aggregator.ts`)
reads only the fields it aggregates, and the collector tests build `Record<string, unknown>` sample literals, so
adding a required `heapSpaces` field to `AgentSample` is type-safe. `src/agent/memory-sampler.ts` is the shape to
mirror for a stateless sampler (`sampleMemory()`, `Math.trunc` on every number). Live Node is `v24.13.1`.

1. **Heap space sampler** (`src/agent/heap-space-sampler.ts`, new):
   - `export type HeapSpaceEntry = { name: string; space_size: number; space_used_size: number; space_available_size: number; physical_space_size: number }`
     — the V8 field names kept as V8 reports them (the SPEC and AC-1 name them that way); all integer bytes.
   - `export type HeapSpaceSample = HeapSpaceEntry[]` — an array of named entries, in V8's order.
   - `export function sampleHeapSpaces(): HeapSpaceSample` — maps `v8.getHeapSpaceStatistics()` from `node:v8`,
     copying `space_name` to `name` and passing each number through a local `toNonNegativeInt` helper
     (`Math.trunc`, clamped to `[0, Number.MAX_SAFE_INTEGER]`, non-finite → 0). Stateless: no enable/disable,
     like `sampleMemory()`.
2. **Sampler controller** (`src/agent/sampler-controller.ts`, modified): `AgentSample` gains
   `heapSpaces: HeapSpaceSample`; each tick adds `heapSpaces: sampleHeapSpaces()` next to `memory`. Nothing to
   enable or disable in `start`/`stop`.
3. **On-demand heap snapshot** (`src/agent/heap-snapshot.ts`, new):
   - `export type HeapSnapshotOptions = { dir: string }`, `export type HeapSnapshotResult = { path: string; bytes: number }`.
   - `export async function takeHeapSnapshot(options: HeapSnapshotOptions): Promise<HeapSnapshotResult>`.
     Being an `async function`, every throw in its body becomes a rejection, so the call can never throw
     synchronously (SPEC constraint + AC-3), including for a missing or non-string `dir` (SPEC assumption).
   - Order inside the body:
     1. Argument check (synchronous part of the body): `options` must be an object and `options.dir` a
        non-empty string, else `throw new TypeError(...)`.
     2. In-progress guard: a module-level `let inProgress = false`. If it is `true`, throw
        `new Error('argus: a heap snapshot is already in progress')`; otherwise set it to `true` — still
        synchronously, before the first `await`, so a second call in the same tick sees it. The rest of the
        body is in `try { … } finally { inProgress = false; }`, so the flag is cleared when the promise settles
        either way.
     3. `const dir = path.resolve(options.dir)`; `await fs.promises.stat(dir)` — an `ENOENT` (or a non-directory)
        becomes `new Error(\`argus: heap snapshot directory does not exist: ${dir}\`, { cause })`.
     4. `await fs.promises.access(dir, fs.constants.W_OK)` — a failure becomes
        `new Error(\`argus: heap snapshot directory is not writable: ${dir}\`, { cause })`. Both refusals happen
        before anything is written, so no `.heapsnapshot` file is left behind.
     5. File name: `argus-<ISO timestamp with ':' and '.' replaced by '-'>-<pid>-<per-process counter>.heapsnapshot`
        joined onto `dir`. The monotonically increasing module-level counter makes two calls in the same
        millisecond differ; the pid separates processes.
     6. `v8.writeHeapSnapshot(filePath)` (synchronous; it runs after the awaits above, so the "in progress"
        window spans from the call until settlement — the SPEC's assumption). A throw is wrapped as
        `new Error(\`argus: heap snapshot write failed: ${filePath}\`, { cause })`, after a best-effort
        `fs.promises.rm(filePath, { force: true })` whose own failure is attached, never swallowed silently
        (it is reported in the error message).
     7. `const { size } = await fs.promises.stat(writtenPath)`; resolve `{ path: writtenPath, bytes: Math.trunc(size) }`.
   - Imports: `node:v8`, `node:fs`, `node:path`, `node:process` only.
4. **Entrypoint** (`src/agent/index.ts`, modified): add
   `export { sampleHeapSpaces } from './heap-space-sampler.js';`,
   `export type { HeapSpaceEntry, HeapSpaceSample } from './heap-space-sampler.js';`,
   `export { takeHeapSnapshot } from './heap-snapshot.js';`,
   `export type { HeapSnapshotOptions, HeapSnapshotResult } from './heap-snapshot.js';`. Nothing removed.

Constraints held by construction: Node core imports only, no `async_hooks`, no third-party or cross-module import
(inside the eslint agent boundary); every number passes through integer conversion; no Node runtime flag is
needed (`getHeapSpaceStatistics` and `writeHeapSnapshot` are always available); no dependency, script, config or
test-infra file changes.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there
  are no lessons to apply.

## Steps

- Add `src/agent/heap-space-sampler.ts` with `HeapSpaceEntry`, `HeapSpaceSample`, the local integer helper and
  `sampleHeapSpaces()`.
- In `src/agent/sampler-controller.ts`, add `heapSpaces: HeapSpaceSample` to `AgentSample` and
  `heapSpaces: sampleHeapSpaces()` to each tick's sample.
- Add `src/agent/heap-snapshot.ts` with `takeHeapSnapshot` per Approach step 3.
- In `src/agent/index.ts`, add the four re-export lines.
- Run `npx prettier --write` on each touched file, then `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run build` and `npm run check:exports`.

## Files

- `src/agent/heap-space-sampler.ts` — new: `sampleHeapSpaces()` over `v8.getHeapSpaceStatistics()`, integer per-space sizes
- `src/agent/heap-snapshot.ts` — new: `takeHeapSnapshot({ dir })`, promise-based, in-progress guard, directory existence and writability refusals, unique timestamped `.heapsnapshot` name
- `src/agent/sampler-controller.ts` — modified: `AgentSample` gains `heapSpaces`; each tick reads `sampleHeapSpaces()`
- `src/agent/index.ts` — modified: re-exports `sampleHeapSpaces`, `takeHeapSnapshot` and their types

### Explicitly not touched

- `src/agent/memory-sampler.ts` — reused as the shape to mirror; unchanged.
- `src/agent/auto.ts`, `src/agent/auto-start.ts` — `auto.ts` already re-exports everything from `index.ts`.
- `src/agent/ndjson-exporter.ts`, `src/agent/ndjson-encoder.ts` — serialize whatever sample they are given.
- `src/collector/window.ts`, `src/collector/window-aggregator.ts`, `src/collector/collector.ts` — read only the fields they aggregate; aggregating heap spaces is not in this slice.
- Other features' tests under `src/agent/` and `src/collector/` — they read `AgentSample` by key and stay valid.
- `package.json`, `vitest.config.mts`, `tsconfig.base.json`, `eslint.config.mjs`, `scripts/build.mjs` — test and build infrastructure, out of scope.

## Acceptance mapping

- **AC-1** (direct read lists `new_space` and `old_space` with four non-negative integer sizes; the controller's
  sample carries `heapSpaces` of the same shape beside `eventLoop`, `memory`, `gc`, `backpressure`; unit) →
  `sampleHeapSpaces()` maps every V8 space with `name` and integer sizes; the controller adds
  `heapSpaces: sampleHeapSpaces()` to each tick's sample.
- **AC-2** (two sequential awaited calls resolve with distinct `.heapsnapshot` paths in the dir, file size equals
  integer `bytes > 0`, content parses as JSON with `snapshot.meta`; integration) → the per-process counter makes
  the names distinct; `bytes` comes from `stat` of the written file; `v8.writeHeapSnapshot` writes the standard
  snapshot JSON.
- **AC-3** (no synchronous throw; missing and non-writable dirs reject with an `Error` naming the dir and leave
  no file; two same-tick calls: first resolves, second rejects "already in progress"; integration) → the
  `async function` turns every throw into a rejection; `stat`/`access` refuse before any write with messages
  that include the resolved `dir`; the in-progress flag is set synchronously before the first `await`.

## Risks & open questions

- **Message naming the directory.** The error message carries `path.resolve(options.dir)`. A test passing an
  absolute temp path (as `mkdtempSync` returns) sees it verbatim. On macOS `os.tmpdir()` may be a symlinked
  path; `path.resolve` does not resolve symlinks, so the message still contains the string the test passed.
- **Non-writable dir and root.** AC-3 makes a temp dir read-only (`chmod 0o500`); as the SPEC assumes, this
  does not hold when tests run as root. The test should restore permissions before cleanup.
- **Snapshot size and time.** A heap snapshot of a vitest worker can be tens of MB and take seconds; the AC-2
  and AC-3 tests should raise their per-test timeout (e.g. 60 s) and parse the file once each.
- **Module-level in-progress state.** The guard is per module instance; the ESM and CJS copies of the package
  each have their own (dual-package hazard, already accepted in `agent-entry`). Two concurrent snapshots from
  the two copies are not refused; accepted for this slice.
- **Name shape** (`sampleHeapSpaces`, `HeapSpaceEntry` with V8's snake_case fields, `takeHeapSnapshot`,
  `HeapSnapshotResult`) is this plan's choice where the SPEC left it open. Flagged for `/pharn-grill`.
