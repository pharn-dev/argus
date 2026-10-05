---
spec_id: agent-gc-events
state: Approved
spec_content_hash: 484b89051d0f701c553ec2645afb6d3e52fbfa6d425e7e2802f0b8e9a4228220
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S1 (agent core), slice 4: GC events (FEATURES.md §2, "GC events (frequency, pause
durations)"). A developer diagnosing a slow or memory-pressured Node.js process needs to see how often
garbage collection runs and how long it pauses the process, without starting Node with `--trace-gc` and
without third-party code. This slice gives the agent a GC sampler, built on Node core's in-process GC
performance entries, and adds its per-window readings to the combined sample the controller already emits.

## Scope

**In scope:**

- A GC sampler that observes Node core's `gc` performance entries (`node:perf_hooks`
  `PerformanceObserver`) and, per sampling window, reports as integers: the total GC count, the total
  pause time and the maximum single pause (both in integer nanoseconds), and a per-kind count breakdown
  for minor, major, incremental and weakcb collections, taken from each entry's `detail.kind`.
- Window semantics like the event loop sampler: each read returns the current window's stats and resets
  them; a window with no GC reports zeros everywhere.
- The sampler controller's combined sample gains a `gc` part from this sampler, and the controller's
  `stop()` disconnects the observer, so no observer is left running and nothing keeps the process alive.
- The sampler exported from `src/agent/index.ts`, using Node core only, with vitest tests.

**Out of scope (non-goals):**

- User-stream backpressure probes.
- The `require('argus/agent')` / `--require` entry point.
- Parsing `--trace-gc` or `--trace-deopt` output, or requiring any Node flag at runtime.
- Heap snapshots and per-GC event streaming (only per-window aggregates are reported).

## Acceptance Criteria

- **AC-1** Given a GC sampler imported from the agent entrypoint and started When no garbage collection
  happens before it is read, and then GC is forced (via allocation churn or `global.gc()` in a child
  `node --expose-gc` process) before it is read again Then the first read returns a count of 0, a total
  pause of 0, a max pause of 0 and zero for every kind; the second read returns a count of at least 1,
  a total pause and max pause that are non-negative integers with max not greater than total, and
  per-kind counts (minor, major, incremental, weakcb) that are non-negative integers; and a third read
  with no GC in between returns zeros again, showing the window was reset
  - verify: integration
- **AC-2** Given a sampler controller imported from the agent entrypoint and started with a short interval
  and a callback When one interval elapses Then the callback's sample carries a `gc` part with count,
  total pause, max pause and the four per-kind counts, every one a non-negative integer, alongside the
  existing event loop and memory parts
  - verify: unit
- **AC-3** Given a separate Node process that only starts the sampler controller (with its GC sampler),
  forces some allocation, and then calls `stop()` When that process schedules no other work Then it exits
  on its own with exit code 0, and no sample is delivered to the callback after `stop()` returns
  - verify: integration

## Constraints

- `src/agent` imports Node core modules only: zero third-party and zero workspace dependencies.
- No `async_hooks` import (reserved for the agent's context module).
- All reported GC numbers are integers; pause durations are integer nanoseconds.
- No Node runtime flag is required for the sampler to work; `--expose-gc` is allowed only in tests.
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build must keep
  compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for both unit and integration criteria, with
  per-test results already configured; the test stage's preflight decides whether that holds.
- Integer nanoseconds is chosen for pause durations to match the event loop sampler's unit; durations
  from the performance entry (float milliseconds) are converted and rounded to integers.
- The per-kind breakdown counts each entry once under the kind its `detail.kind` names; an entry whose
  kind is none of the four is still counted in the total but in no kind bucket.
- Because GC timing is not deterministic, AC-1's "no GC" read is taken in a controlled child process
  (or immediately after start) so the zero window is reliable; the PLAN chooses the mechanism.
- Exact exported names, the sample field names and the callback signature are left to the PLAN; the
  criteria only require they are reachable from the agent entrypoint.
- The controller creates and owns its GC sampler, as it does the event loop sampler; `start` connects the
  observer and `stop` disconnects it, and calling `stop` twice is a harmless no-op.
