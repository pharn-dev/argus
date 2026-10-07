---
spec_id: agent-allocation-sampling
spec_content_hash: 63025b8f5b9b93838148e7b6a281c8c67b387d9d9a0daa7a336fcf9ebbdca15c
applied_lessons: none
---

## Approach

> ADVISORY: model work, derived from the Approved SPEC `agent-allocation-sampling` (`spec_kind: quick`, ROADMAP S5,
> FEATURES.md §3 "Allocation timeline / sampling profiler capture").

Discovery (live, this run): the agent is `src/agent/` of a single npm package. `src/agent/index.ts` is the
side-effect-free library entry; `src/agent/auto.ts` re-exports it, so anything exported from `index.ts` is also
reachable from `argus/agent`. `src/agent/heap-snapshot.ts` (`takeHeapSnapshot`) is the shape to mirror: an
`async function` (so every throw is a rejection), a module-level `inProgress` flag set synchronously before the first
`await` and cleared in `finally`, `argus:`-prefixed error messages, cleanup failures reported, never swallowed.
`eslint.config.mjs` restricts `src/agent/**/*.ts` (non-test) to `node:` builtins and relative imports.
`@types/node` types `node:inspector/promises` `Session.post('HeapProfiler.startSampling', { samplingInterval })`
→ `Promise<void>` and `post('HeapProfiler.stopSampling')` → `Promise<{ profile: SamplingHeapProfile }>`, with
`SamplingHeapProfileNode = { callFrame: { functionName, url, lineNumber (0-based), … }, selfSize, children, … }`.

**Live probe of the inspector API (this run, an in-process `node:inspector` Session, no flags), identical on
Node v22.19.0 and v24.13.1:** `HeapProfiler.enable` → `startSampling({ samplingInterval: 512 })` → a named function
retaining `new Array(1000)` objects on a 5 ms interval for 200 ms → `stopSampling` returned a profile with keys
`head`, `samples`; the named function appeared as one node with `lineNumber: 0` (0-based) and an integer `selfSize`
of ~56 MB; every `selfSize` was an integer. `stopSampling` without a running sampling rejected
("V8 sampling heap profiler was not started"); `samplingInterval: 0` rejected ("Invalid sampling interval"); a second
`startSampling` on a running session was accepted silently (so the in-process guard below is what enforces AC-2, not
V8). The `includeObjectsCollectedByMajorGC` / `includeObjectsCollectedByMinorGC` parameters were *accepted* on both
versions, but acceptance does not prove they are honoured (the protocol ignores unknown parameters), so **this plan
does not use them**: the profile reports allocations still live at stop time, which is what AC-1's test function
(it retains its objects) needs.

1. **Profile aggregation** (`src/agent/allocation-profile.ts`, new — pure, no I/O, one reason to change: how a
   V8 sampling profile becomes sites):
   - `export type AllocationSite = { functionName: string; url: string; line: number; bytes: number }`.
   - `export function aggregateAllocationProfile(head: SamplingHeapProfileNode-like, limit: number): AllocationSite[]`
     with a local structural type `{ callFrame: { functionName: string; url: string; lineNumber: number }; selfSize: number; children: readonly Node[] }`
     (structural, so the pure module needs no `node:inspector` import).
   - Walks the tree **iteratively** (explicit stack, no recursion-depth risk). For every node with `selfSize > 0`
     it adds `Math.trunc(selfSize)` to a `Map` keyed by `functionName + '\u0000' + url + '\u0000' + line`.
     Integer addition only; totals clamped to `Number.MAX_SAFE_INTEGER`.
   - **Line numbers are reported 1-based**: `line = lineNumber + 1` when `lineNumber >= 0`, else `0` (V8's
     "no line"). 1-based matches stack traces and editors; the JSDoc says so.
   - **Filtering:** only nodes with `selfSize > 0` contribute, so every reported site has `bytes > 0`. Sites with an
     empty url or empty function name (`(root)`, V8 internals, anonymous functions) are **kept** and reported as V8
     gives them (`functionName` may be `''`); they are real allocations, and nothing in the criteria tests them.
   - Order: `bytes` descending, ties broken by `url`, then `line`, then `functionName` ascending (deterministic).
     Returns the first `limit` sites.
2. **Sampling call** (`src/agent/allocation-sampler.ts`, new — the inspector session lifecycle):
   - `export type AllocationSamplingOptions = { samplingInterval?: number; durationMs?: number; limit?: number }`.
   - `export const DEFAULT_ALLOCATION_SAMPLING_INTERVAL = 32768` (V8's default), `DEFAULT_ALLOCATION_SAMPLING_DURATION_MS = 1000`,
     `DEFAULT_ALLOCATION_SITE_LIMIT = 20`. The caller may override all three.
   - `export async function sampleAllocations(options: AllocationSamplingOptions = {}): Promise<AllocationSite[]>`.
     Being an `async function`, every throw becomes a rejection, so it never throws synchronously.
   - Order inside the body:
     1. **Validation** (before taking the guard, so an invalid call never blocks a valid one): `options` must be
        `undefined` or a non-null object, else `TypeError('argus: sampleAllocations options must be an object')`.
        Each of `samplingInterval`, `durationMs`, `limit`, when present (not `undefined`), must satisfy
        `Number.isSafeInteger(v) && v > 0`, else `TypeError(\`argus: sampleAllocations option ${name} must be a positive integer\`)` —
        the message names the option (AC-3). `durationMs` is additionally capped at `2147483647` (the `setTimeout`
        maximum, beyond which Node fires after 1 ms) with a message naming `durationMs`.
     2. **In-progress guard:** module-level `let inProgress = false`. If `true`, throw
        `new Error('argus: an allocation sampling session is already in progress')`; else set it `true` —
        synchronously, before the first `await`, so a same-tick second call sees it (AC-2). Everything after is in
        `try { … } finally { inProgress = false; }`, so the guard spans from the call until the promise settles.
     3. **Session:** `const session = new Session()` from `node:inspector/promises`; `session.connect()`.
        Then `await session.post('HeapProfiler.enable')`, `await session.post('HeapProfiler.startSampling', { samplingInterval })`
        (sets `started = true` after it resolves), `await setTimeout(durationMs)` from `node:timers/promises` (a
        ref'd timer, so the promise settles even if nothing else keeps the process alive), then
        `const { profile } = await session.post('HeapProfiler.stopSampling')` (sets `stopped = true`).
     4. **Cleanup in `finally` (always, also when a step failed):** if `started && !stopped`, best-effort
        `post('HeapProfiler.stopSampling')`; if enabled, `post('HeapProfiler.disable')`; if connected,
        `session.disconnect()`. Each cleanup failure is collected, never swallowed: if the main path succeeded but
        cleanup failed, reject with `new Error('argus: allocation sampling cleanup failed: <messages>', { cause })`;
        if the main path failed, reject with the main failure wrapped as
        `new Error(\`argus: allocation sampling failed: ${message}\${cleanup suffix}\`, { cause })` where the suffix
        lists any cleanup failures (same pattern as `heap-snapshot.ts`).
     5. Resolve `aggregateAllocationProfile(profile.head, limit)`.
   - Imports: `node:inspector/promises`, `node:timers/promises`, `./allocation-profile.js` only. No `async_hooks`.
3. **Entrypoint** (`src/agent/index.ts`, modified): add
   `export { sampleAllocations, DEFAULT_ALLOCATION_SAMPLING_INTERVAL, DEFAULT_ALLOCATION_SAMPLING_DURATION_MS, DEFAULT_ALLOCATION_SITE_LIMIT } from './allocation-sampler.js';`,
   `export type { AllocationSamplingOptions } from './allocation-sampler.js';`,
   `export type { AllocationSite } from './allocation-profile.js';`. Nothing removed.

Constraints held by construction: Node core imports only (`node:inspector/promises`, `node:timers/promises`), no
`async_hooks`, no third-party or cross-module import (inside the eslint agent boundary); byte totals and lines are
integers summed with integer math; no runtime flag (an in-process inspector Session needs none — probed on both
versions); session always stopped/disabled/disconnected in `finally`; no dependency, script, config or test-infra
file changes; both `node:inspector/promises` and `node:timers/promises` exist on Node 22 and 24 and in the CJS build.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there are
  no lessons to apply.

## Steps

- Add `src/agent/allocation-profile.ts` with `AllocationSite` and `aggregateAllocationProfile` per Approach step 1.
- Add `src/agent/allocation-sampler.ts` with the options type, the three defaults and `sampleAllocations` per
  Approach step 2.
- In `src/agent/index.ts`, add the re-export lines.
- Run `npx prettier --write` on each touched file, then `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run build` and `npm run check:exports`, on Node 22 (the floor) and Node 24.

## Files

- `src/agent/allocation-profile.ts` — new: `AllocationSite` type and pure `aggregateAllocationProfile(head, limit)` (iterative walk, integer sums keyed by function/url/1-based line, bytes-desc order, capped)
- `src/agent/allocation-sampler.ts` — new: `sampleAllocations(options)` over a `node:inspector/promises` Session, option validation, per-process in-progress guard, always-cleanup, defaults
- `src/agent/index.ts` — modified: re-exports `sampleAllocations`, the defaults and the two types

### Explicitly not touched

- `src/agent/heap-snapshot.ts` — reused as the pattern to mirror; unchanged.
- `src/agent/auto.ts`, `src/agent/auto-start.ts` — `auto.ts` already re-exports everything from `index.ts`.
- `src/agent/context.ts` — the only `async_hooks` user; untouched.
- `src/agent/sampler-controller.ts`, `src/agent/ndjson-exporter.ts` — sampling is on demand, not part of the periodic sample or the NDJSON export (SPEC non-goal).
- `src/analyzer/`, `src/dashboard/`, `src/collector/` — symbolization, exposure and aggregation of profiles are non-goals.
- `package.json`, `vitest.config.mts`, `tsconfig.base.json`, `eslint.config.mjs`, `scripts/build.mjs` — test and build infrastructure, out of scope.

## Acceptance mapping

- **AC-1** (named retaining test function sampled with a small interval and short duration → non-empty sites, each
  string `functionName`, string `url`, integer `line`, integer `bytes > 0`, ordered largest first, test function
  present; integration) → `startSampling` with the caller's interval, the duration timer, `stopSampling`, then
  `aggregateAllocationProfile` keeps only `selfSize > 0` nodes, sums them per function/url/line as integers and
  sorts bytes-descending; the live probe shows a retaining named function appears by name on Node 22 and 24. The
  test should pass a `limit` large enough (or rely on the default 20) that its function is not cut, keep allocating
  across the whole duration, and retain what it allocates until the call resolves.
- **AC-2** (two same-tick calls: no sync throw, first resolves with sites, second rejects with an `Error` saying a
  session is already in progress; a third call after both settle resolves; integration) → `async function` (no sync
  throw); the guard is set before the first `await` and cleared in `finally`; message contains
  "already in progress".
- **AC-3** (non-positive-integer `samplingInterval`, separately `durationMs` → no sync throw, each rejects with an
  `Error` naming the option; a later valid call resolves; unit) → validation throws `TypeError` (an `Error`) naming
  the option, inside the `async function`, before the guard is taken, so the later valid call is not blocked.

## Risks & open questions

- **Only live objects are reported.** Without the `includeObjectsCollectedBy*` parameters (deliberately unused:
  unverifiable that Node 22 honours them), V8 drops samples whose objects were collected before `stopSampling`.
  AC-1's test function must retain its allocations until the call resolves (the SPEC's test shape does).
- **Sampling is probabilistic.** With a small interval (e.g. 512–4096 bytes) and multi-MB retained allocations
  across ~200–500 ms the probe sampled the function heavily; the test should still allocate throughout the duration.
- **Default limit 20** is this plan's choice (SPEC left it open); overridable via `limit`, which is validated like the
  other options. Flagged for `/pharn-grill`.
- **1-based `line`** is this plan's choice (V8 gives 0-based); documented in the JSDoc. Flagged for `/pharn-grill`.
- **Dual-package and foreign sessions.** The guard is per module instance (ESM and CJS copies each have one) and does
  not see a debugger's own inspector session; both accepted by the SPEC's assumptions.
- **Ref'd duration timer.** The call keeps the event loop alive for `durationMs`; intended, so the promise always
  settles. Name shape (`sampleAllocations`, `AllocationSite`, `durationMs`) is this plan's choice where the SPEC left
  it open.
