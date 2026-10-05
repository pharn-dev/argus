---
spec_id: agent-samplers
state: Approved
spec_content_hash: 4de3b7fa138e2b3380e9c01fed10064b5806a55c77d86825ba43f2184dfd64ad
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S1 (agent core), first slice. A developer who drops the Argus agent into a Node.js process
needs the agent to collect its two most basic runtime signals, event loop lag and memory, on a fixed
interval, without third-party code and without keeping the monitored process alive. This slice gives the
agent its runtime samplers and a controller that drives them, so later slices (NDJSON export, config, GC,
backpressure) have samples to build on.

## Scope

**In scope:**

- An event loop lag sampler built on Node's `perf_hooks.monitorEventLoopDelay`: each sample reports the
  window's min, max, mean, p50 and p99 as integer nanoseconds, then resets the histogram so the next
  window starts fresh.
- A memory sampler: each sample reports heapUsed, heapTotal, rss, external and arrayBuffers as integer
  bytes, read from `process.memoryUsage()`.
- A sampler controller with `start(intervalMs)` and `stop()` that emits one combined sample (an integer
  millisecond timestamp plus the event loop and memory readings) per interval to a callback. Its timer is
  unref'd so it never keeps the process alive; `stop()` disables the histogram and clears the timer;
  calling `start` twice is idempotent.
- All of it exported from `src/agent/index.ts`, using Node core only (no third-party and no workspace
  dependencies), with unit-level vitest tests.

**Out of scope (non-goals):**

- NDJSON export or any stream output of samples.
- Configuration loading or options beyond the interval.
- GC event sampling and stream backpressure sampling.
- Tracing, AsyncLocalStorage or async_hooks usage.

## Acceptance Criteria

- **AC-1** Given a sampler controller imported from the agent entrypoint and started with a short interval
  and a callback When one interval elapses Then the callback receives one sample whose timestamp is an
  integer number of milliseconds, whose event loop part has min, max, mean, p50 and p99 as non-negative
  integers (nanoseconds), and whose memory part has heapUsed, heapTotal, rss, external and arrayBuffers
  as non-negative integers (bytes)
  - verify: unit
- **AC-2** Given a running controller where the event loop was blocked for about 100 ms during one
  interval When the sample for the following, unblocked interval is emitted Then the blocked interval's
  sample reports an event loop max of at least 50 ms in nanoseconds and the following sample reports an
  event loop max below that value, showing the histogram was reset between windows
  - verify: unit
- **AC-3** Given a controller When `start` is called twice and then `stop` is called Then samples arrive
  at most once per interval while running and no sample arrives after `stop` returns; and a separate Node
  process that only starts the controller and schedules no other work exits on its own with exit code 0
  - verify: integration

## Constraints

- `src/agent` imports Node core modules only: zero third-party and zero workspace dependencies.
- No `async_hooks` import in this slice (that is reserved for the agent's context module).
- All reported numbers are integers; no floating-point values in a sample.
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build must keep
  compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for both unit and integration criteria, with
  per-test results already configured; the test stage's preflight decides whether that holds.
- "stop() disables the histogram" is an internal effect with no public observation of its own; it is
  checked through its observable result (no samples after `stop`), not directly.
- The exact exported names and the callback signature are left to the PLAN; the criteria only require
  that they are reachable from the agent entrypoint.
- Mean is rounded to an integer nanosecond value, since the histogram reports it as a float.
- AC-2's 100 ms block and 50 ms threshold are chosen to stay robust on a loaded CI machine; the PLAN may
  pick the interval length.
- Calling `stop()` on a controller that was never started is a harmless no-op.
