---
spec_id: agent-gc-events
spec_content_hash: 484b89051d0f701c553ec2645afb6d3e52fbfa6d425e7e2802f0b8e9a4228220
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `agent-gc-events` (ROADMAP S1, slice 4).

Discovery (live, this run): the agent lives in `src/agent/` of a single npm package (not the pnpm monorepo
`CLAUDE.md` describes). `src/agent/event-loop-sampler.ts` exposes `createEventLoopSampler()` with
`enable()` / `disable()` / `sample()` (read then reset, empty window gives zeros, a local
`toNonNegativeInt` helper). `src/agent/sampler-controller.ts` owns that sampler, builds
`AgentSample = { timestamp, eventLoop, memory }` per unref'd `setInterval` tick, and `stop()` clears the
timer and disables the sampler (a no-op when idle). `src/agent/index.ts` re-exports everything. The only
code that builds an `AgentSample` literal is the controller; the existing tests and the NDJSON exporter
only read it, so adding a required `gc` field is type-safe. Live Node (`v24.13.1`) exposes
`perf_hooks.constants.NODE_PERFORMANCE_GC_MINOR` (1), `_MAJOR` (4), `_INCREMENTAL` (8) and `_WEAKCB` (16).

The GC sampler mirrors the event loop sampler's shape so the controller treats both the same way:

1. **GC sampler** (`src/agent/gc-sampler.ts`, new):
   - `createGcSampler(): GcSampler`, where
     `GcSampler = { enable(): void; disable(): void; sample(): GcSample }`.
   - `GcSample = { count: number; totalPause: number; maxPause: number; kinds: { minor: number; major: number; incremental: number; weakcb: number } }`.
     `totalPause` and `maxPause` are integer nanoseconds (same unit as `EventLoopSample`, documented in a
     doc comment); `count` and the kind buckets are integer counts.
   - One `PerformanceObserver` from `node:perf_hooks`. `enable()` resets the window and calls
     `observer.observe({ entryTypes: ['gc'] })`; calling it while already enabled is a no-op.
     `disable()` calls `observer.disconnect()`; a no-op when not enabled.
   - The observer callback folds each `gc` entry into the current window with integer math only:
     `pauseNs = toNonNegativeInt(entry.duration * 1_000_000)` (float ms → rounded integer ns, clamped to
     `[0, Number.MAX_SAFE_INTEGER]`, NaN → 0); `count += 1`; `totalPause` adds `pauseNs` with a saturating
     clamp at `Number.MAX_SAFE_INTEGER`; `maxPause = Math.max(maxPause, pauseNs)`.
   - Kind: read `entry.detail` by narrowing from `unknown` (an object with a numeric `kind`, no `any`) and
     compare it against the four `perf_hooks.constants.NODE_PERFORMANCE_GC_*` values. A matching kind
     increments its bucket; any other or missing kind is counted in `count` only (SPEC assumption).
   - `sample()` first drains `observer.takeRecords()` into the window (so any entries the observer already
     buffered are not lost or deferred), returns a copy of the window, then resets every field to 0. A
     window with no GC returns all zeros.
   - It keeps a local copy of the `toNonNegativeInt` helper rather than importing it from
     `event-loop-sampler.ts` (that file's concern is the event loop; no new shared module is invented for one
     four-line helper).
2. **Sampler controller** (`src/agent/sampler-controller.ts`, modified):
   - `AgentSample` gains `gc: GcSample`.
   - `createSamplerController` creates and owns one `createGcSampler()` next to the event loop sampler.
   - `start` calls `gc.enable()` together with `eventLoop.enable()` (only on the first, timer-creating call);
     each tick adds `gc: gc.sample()` to the sample.
   - `stop` calls `gc.disable()` after `clearInterval`, so the observer is disconnected and nothing is left
     observing. The existing early return keeps a second `stop` a harmless no-op.
3. **Entrypoint** (`src/agent/index.ts`, modified): add `export { createGcSampler } from './gc-sampler.js';`
   and `export type { GcSample, GcSampler } from './gc-sampler.js';`. Nothing is removed.

Constraints held by construction: imports are `node:perf_hooks` plus relative files (inside the eslint agent
boundary); no `async_hooks`; every reported number goes through integer conversion; no Node flag is needed
at runtime (the `gc` entry type is always available); no dependency, config, script or test-infra file is
touched.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there
  are no lessons to apply.

## Steps

- Add `src/agent/gc-sampler.ts` with `createGcSampler`, the `GcSample` and `GcSampler` types, the local
  integer helper, the `detail.kind` narrowing and the read-then-reset `sample()` that drains `takeRecords()`.
- In `src/agent/sampler-controller.ts`, add `gc: GcSample` to `AgentSample`, create the GC sampler in
  `createSamplerController`, enable it in `start`, read it each tick and disable it in `stop`.
- In `src/agent/index.ts`, re-export `createGcSampler`, `GcSample` and `GcSampler`.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run check:exports`; the ESM
  and CJS builds must keep compiling.

## Files

- `src/agent/gc-sampler.ts` — new. `PerformanceObserver`-backed GC sampler: per-window integer count,
  total and max pause (ns) and minor/major/incremental/weakcb counts; read-then-reset.
- `src/agent/sampler-controller.ts` — modified. `AgentSample` gains `gc`; the controller owns, enables,
  reads and disables the GC sampler.
- `src/agent/index.ts` — modified. Re-exports `createGcSampler`, `GcSample`, `GcSampler`.

### Explicitly not touched

- `src/agent/event-loop-sampler.ts` — reused as the shape to mirror; unchanged.
- `src/agent/memory-sampler.ts`, `src/agent/ndjson-exporter.ts`, `src/agent/ndjson-encoder.ts`,
  `src/agent/config.ts` — unchanged; the exporter serializes whatever sample it is given.
- `src/agent/samplers.ac1.test.ts`, `src/agent/samplers.ac2.test.ts`,
  `src/agent/samplers.ac3.integration.test.ts`, `src/agent/ndjson-export.ac3.integration.test.ts` — other
  features' tests; they read `AgentSample` by key and stay valid.
- `vitest.config.mts`, `package.json`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`,
  `eslint.config.mjs`, `scripts/build.mjs` — test and build infrastructure, out of scope.

## Acceptance mapping

- **AC-1** (fresh sampler reads zeros; after forced GC count ≥ 1, integer pauses with max ≤ total, integer
  kind counts; next read zeros again; integration): `createGcSampler()` from the entrypoint, `enable()`, then
  an immediate synchronous `sample()` — no observer callback can have run yet, so the window is zero. Then
  `global.gc()` in a child `node --expose-gc` process, then await a macrotask (GC entries are delivered to the
  observer asynchronously), then `sample()` reports the entries; `maxPause ≤ totalPause` holds because every
  pause is added to the total and `max` is the largest single addend. The reset in `sample()` gives the third
  zero read (taken synchronously right after the second). Test lives in AC-TESTS.md.
- **AC-2** (controller sample carries `gc` with count, total, max and four kinds, all non-negative integers,
  alongside `eventLoop` and `memory`; unit): each tick builds `{ timestamp, eventLoop, memory, gc }` and every
  `gc` field passes through integer conversion.
- **AC-3** (a child process that only starts the controller, allocates and calls `stop()` exits 0 on its own,
  no sample after `stop`; integration): `stop()` clears the unref'd timer (no tick after it returns) and
  disconnects the observer; a `PerformanceObserver` holds no libuv handle, so nothing keeps the process alive.

## Risks & open questions

- **GC entries arrive asynchronously.** After `global.gc()` the `gc` entry reaches the observer on a later
  turn, and `takeRecords()` only sees entries already queued to JS. The AC-1 test must await at least one
  macrotask (e.g. `setTimeout(…, 20)` or a short poll loop) between forcing GC and the second read; it must
  not read synchronously after `global.gc()`.
- **AC-1's zero window.** It relies on reading synchronously right after `enable()` (and right after the
  second read), so even a GC that happens concurrently cannot have been delivered yet. A test that awaits
  before the first read would be flaky.
- **Child-process loader.** As in `samplers.ac3.integration.test.ts`, the AC-1 and AC-3 children cannot run
  the `.ts` sources directly; `/pharn-test` should compile `src/agent/index.ts` with the installed
  `typescript` into a temp dir (with a `{ "type": "module" }` `package.json`) and spawn `process.execPath`
  (with `--expose-gc` for AC-1). No test-infra change.
- **AC-3 "no sample after stop" in a child.** The child should record the sample count when `stop()` returns
  and again in `process.on('exit')`, and print both; the test asserts they are equal and the exit code is 0.
- **Field names** (`count`, `totalPause`, `maxPause`, `kinds.{minor,major,incremental,weakcb}`) are this
  plan's choice; the SPEC left them open. Flagged for `/pharn-grill`.
- **`detail` typing.** `@types/node` types `PerformanceEntry.detail` loosely; the plan narrows from
  `unknown` instead of using `any` (strict mode rule).
- **`CLAUDE.md` is stale** (monorepo / pre-scaffold text); out of scope here, as noted in earlier slices.
