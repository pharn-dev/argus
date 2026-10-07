---
spec_id: agent-allocation-sampling
state: Approved
spec_content_hash: 63025b8f5b9b93838148e7b6a281c8c67b387d9d9a0daa7a336fcf9ebbdca15c
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S5 (V8 / memory depth), FEATURES.md §3 "Allocation timeline / sampling profiler capture", in
`src/agent`. A developer chasing memory growth in a live Node.js process needs to know which code is
allocating the most memory right now, without restarting the process with special flags, without third-party
code, and without the cost of a full heap snapshot. This slice adds an on-demand sampling heap profiler built
on Node core `node:inspector` (a `Session` driving `HeapProfiler.startSampling` / `HeapProfiler.stopSampling`)
that samples for a configurable duration at a configurable sampling interval and returns the top allocation
sites aggregated by function, url and line, with integer byte totals.

## Scope

**In scope:**

- An on-demand allocation sampling call, exported from `src/agent/index.ts`, that takes a sampling interval
  (bytes between samples) and a duration (milliseconds), samples allocations over that duration through
  `node:inspector`, and resolves with the top allocation sites.
- Each reported site carries its function name, script url, line number and the integer total of sampled
  bytes attributed to that function/url/line; sites are ordered by byte total, largest first.
- Only one sampling session at a time: a call made while another is still running rejects with a clear error.
- Invalid options and every inspector failure surface as a rejected promise; the call never throws
  synchronously.
- Node core only, no imports from other `src/` modules, with vitest tests.

**Out of scope (non-goals):**

- An allocation timeline (`HeapProfiler.startTrackingHeapObjects`) or a full heap snapshot.
- CPU profiling.
- Symbolizing or source-mapping the reported sites, or analyzing them in an analyzer Worker Thread.
- Exposing sampling over the dashboard, an HTTP endpoint, a signal handler, or the NDJSON export.
- Continuous or scheduled sampling, or persisting profiles to disk.

## Acceptance Criteria

- **AC-1** Given the allocation sampling call imported from the agent entrypoint and a named test function
  that repeatedly allocates and retains large objects When the call is started with a small sampling
  interval and a short duration while the test function runs during that duration Then it resolves with a
  non-empty list of sites, each carrying a string function name, a string url, an integer line number and an
  integer byte total greater than 0; the list is ordered by byte total, largest first; and the test
  function's name appears among the returned sites
  - verify: integration
- **AC-2** Given the allocation sampling call imported from the agent entrypoint When it is called twice in
  the same tick with a short duration, and then called once more after both settle Then neither call throws
  synchronously; the first resolves with a list of sites; the second rejects with an `Error` whose message
  says a sampling session is already in progress; and the third call, made after the first settled,
  resolves with a list of sites
  - verify: integration
- **AC-3** Given the allocation sampling call imported from the agent entrypoint When it is called with a
  sampling interval that is not a positive integer, and separately with a duration that is not a positive
  integer Then neither call throws synchronously; each rejects with an `Error` whose message names the
  invalid option; and a valid call made afterwards resolves with a list of sites
  - verify: unit

## Constraints

- `src/agent` imports Node core modules only (`node:inspector`, …): zero third-party dependencies and no
  imports from other `src/` modules.
- No `async_hooks` import (reserved for the agent's context module).
- Byte totals and line numbers are integers; aggregation uses integer math.
- No Node runtime flag is required.
- No silent failures: the inspector session is always disconnected and sampling always stopped, also when a
  step fails, and every failure surfaces as a rejected promise with an `Error`.
- Must work on Node 22 and Node 24; TypeScript strict mode; the package's existing dual ESM/CJS build must
  keep compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for both unit and integration criteria, with
  per-test results; the test stage's preflight decides whether that holds.
- "Top" sites means the result is capped at a limit: the PLAN chooses a default limit and whether the caller
  may override it; the criteria only require ordering largest-first and that the test function is present.
- A site's byte total is the sum of `selfSize` over the sampling profile's nodes that share a function name,
  url and line number; the line number is reported as V8 gives it in the profile (the PLAN chooses whether to
  report it 0-based or 1-based and says so).
- Sites with an empty url or anonymous function name (V8 internals, `(root)`) may be reported or filtered as
  the PLAN chooses; they are not criterion-tested.
- Defaults for the sampling interval and the duration, when omitted, are chosen by the PLAN; V8's own default
  sampling interval is 32768 bytes.
- "Already in progress" means from the moment the call is made until its promise settles; the concurrency
  guard is per process. A separate inspector session opened by other code (for example a debugger) is not
  detected and is not criterion-tested.
- The test function's allocations are large and frequent enough, with a small sampling interval, that it is
  sampled reliably within a short duration; the test may need to keep allocating across the whole duration.
