---
spec_id: agent-v8-heap
state: Approved
spec_content_hash: 578bb8916e3b3de896ebbb5850bd5da168b7b3ca12a7680f0de3115457a99896
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S5 (V8 / memory depth), slice 1, in `src/agent`: FEATURES.md §3 "`v8.getHeapSpaceStatistics()`
exposure" and "On-demand heap snapshots". A developer chasing memory growth in a Node.js process needs to see
which V8 heap space (new space, old space, code space, large object space, …) is growing, interval by
interval, and needs to capture a heap snapshot on demand for later analysis — without third-party code and
without restarting the process with special flags. This slice adds a per-space heap statistics sampler to the
combined sample the agent already emits, and a safe, promise-based on-demand heap snapshot capture.

## Scope

**In scope:**

- A heap space sampler, built on Node core `node:v8` `getHeapSpaceStatistics()`, that returns one entry per
  V8 heap space, each with the space's name and integer `space_size`, `space_used_size`,
  `space_available_size` and `physical_space_size` in bytes.
- The sampler controller's combined sample gains a `heapSpaces` part from this sampler, alongside the
  existing event loop, memory, gc and backpressure parts.
- `takeHeapSnapshot({ dir })`, which writes a `.heapsnapshot` file via `v8.writeHeapSnapshot` into the given
  directory under a timestamped, unique file name and resolves with `{ path, bytes }`.
- `takeHeapSnapshot` refuses, by returning a rejected promise with a clear error, when a snapshot is already
  in progress, when the directory does not exist, and when the directory is not writable; it never throws
  synchronously out of the call.
- Both exported from `src/agent/index.ts`, Node core only, with vitest tests.

**Out of scope (non-goals):**

- Heap snapshot analysis, diffing or leak detection (a later slice, in the analyzer Worker Thread pool).
- Allocation timeline or sampling profiler capture.
- Deoptimization detection or `--trace-deopt` parsing.
- Exposing snapshot capture over the dashboard, an HTTP endpoint or a signal handler.
- Creating the snapshot directory, rotating or deleting old snapshot files, or disk-space checks.

## Acceptance Criteria

- **AC-1** Given the heap space sampler and the sampler controller imported from the agent entrypoint When
  the sampler is read directly, and the controller is started with a short interval and a callback and one
  interval elapses Then the direct read returns a non-empty list of entries whose names include `new_space`
  and `old_space`, each carrying `space_size`, `space_used_size`, `space_available_size` and
  `physical_space_size` as non-negative integers; and the callback's sample carries a `heapSpaces` part of
  the same shape alongside the existing `eventLoop`, `memory`, `gc` and `backpressure` parts
  - verify: unit
- **AC-2** Given an existing, writable temporary directory When `takeHeapSnapshot({ dir })` is imported
  from the agent entrypoint and called twice in sequence (each awaited) Then each call resolves with a
  `path` that is inside that directory and ends in `.heapsnapshot`, the two paths differ, each file
  exists with a size equal to the resolved integer `bytes` (greater than 0), and each file's content
  parses as JSON whose top-level object has a `snapshot` key with a `meta` object
  - verify: integration
- **AC-3** Given `takeHeapSnapshot` imported from the agent entrypoint When it is called with a directory
  that does not exist, with a directory that exists but is not writable, and twice in the same tick
  against a writable directory Then none of these calls throws synchronously (each returns a promise);
  the missing-directory and non-writable-directory calls reject with an `Error` whose message names the
  directory, and leave no `.heapsnapshot` file behind; and of the two same-tick calls the first resolves
  with a snapshot while the second rejects with an `Error` whose message says a snapshot is already in
  progress
  - verify: integration

## Constraints

- `src/agent` imports Node core modules only (`node:v8`, `node:fs`, `node:path`, …): zero third-party
  dependencies and no imports from other `src/` modules.
- No `async_hooks` import (reserved for the agent's context module).
- All reported heap space numbers and the snapshot `bytes` are integers.
- No Node runtime flag is required for either feature.
- No silent failures: every refusal or write failure surfaces as a rejected promise with an `Error`.
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build must keep
  compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for both unit and integration criteria, with
  per-test results; the test stage's preflight decides whether that holds.
- `v8.writeHeapSnapshot` is synchronous; "already in progress" means from the moment `takeHeapSnapshot`
  is called until its promise settles, so a second call made before the first settles (for example in the
  same tick) is refused. The PLAN chooses how the write is deferred so that window exists.
- "Not writable" is checked before writing (for example by an access check) and the test makes a temporary
  directory read-only; the test is assumed not to run as root, where permission bits are not enforced.
- The exact shape of the sampler's return value (an array of named entries or an object keyed by space
  name), exported names, and the file-name format beyond "timestamped, unique, `.heapsnapshot` suffix"
  are left to the PLAN; the criteria only require them to be reachable from the agent entrypoint.
- `takeHeapSnapshot` with no `dir`, or with a `dir` that is not a string, rejects rather than throws; this
  follows from the "never throws synchronously" requirement and is not separately criterion-tested.
- `new_space` and `old_space` are present in `getHeapSpaceStatistics()` on every supported Node version
  (22+); other space names vary by V8 version and are reported as V8 returns them.
