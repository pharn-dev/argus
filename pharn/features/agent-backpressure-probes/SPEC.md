---
spec_id: agent-backpressure-probes
state: Approved
spec_content_hash: 063a575a3ae94498260e9cd7179435f94571a8577b8235252678cac1f309d6dd
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S1 (agent core), slice 5: stream backpressure probes (FEATURES.md §2, "Stream backpressure
hotspots (where streams stall)"). A developer diagnosing a slow Node.js process needs to see which streams
stall because their consumer cannot keep up, how often, and for how long, without instrumenting their own
code and without third-party dependencies. This slice gives the agent a backpressure probe that observes
every Writable in the process, attributes each stalled stream to the code site that created the stall, and
adds its per-window hotspot readings to the combined sample the controller already emits.

## Scope

**In scope:**

- A backpressure probe that, when enabled, observes every Writable in the process (for example by wrapping
  `node:stream` `Writable.prototype.write` once) and records a backpressure event each time `write()`
  returns false, plus the stall duration until that stream's next `'drain'`, in integer nanoseconds from
  `process.hrtime.bigint()`.
- Site attribution: each stalled stream is attributed to the first stack frame outside Node internals and
  outside the agent itself at the moment the stream first stalled (`file:line`), falling back to the
  stream's constructor name; the stack is captured only on a stream's first stall, never on every write.
- Per sampling window (read-and-reset like the other samplers), integer readings: total stall events,
  total stall time, max stall time, and the top hotspots (at most N sites, ranked by total stall time),
  each with its site, events, total stall and max stall.
- `disable()` restores the original `Writable.prototype.write` exactly (same function identity) and stops
  attributing; enabling twice is idempotent; the agent's own NDJSON exporter destination is excluded from
  the probe.
- The sampler controller's combined sample gains a `backpressure` part from this probe, and `stop()`
  disables it.
- The probe exported from `src/agent/index.ts`, Node core only, with vitest tests.

**Out of scope (non-goals):**

- The `require('argus/agent')` / `--require` entry point (the next slice).
- Readable-side or Duplex-read backpressure, and `pipeline()` / `.pipe()` specific instrumentation.
- Per-event streaming of stalls (only per-window aggregates are reported).
- Any instrumentation of user code beyond the single prototype wrap.

## Acceptance Criteria

- **AC-1** Given a backpressure probe imported from the agent entrypoint and enabled When a test creates a
  Writable with a small highWaterMark whose consumer is slow, writes until `write()` returns false, lets it
  drain, repeats that stall a known number of times, and then reads the probe twice Then the first read
  returns a total event count equal to the number of stalls, a total stall time and a max stall time that
  are non-negative integers with max not greater than total, and a hotspot list of at most N entries
  ordered by total stall time descending whose entry for that stream has a site naming the test file as
  `file:line` (not a Node-internal or agent path) with events, total and max stall that are integers; and
  the second read returns zero events, zero totals and an empty hotspot list, showing the window was reset
  - verify: integration
- **AC-2** Given the original `Writable.prototype.write` captured before the probe is enabled When the
  probe is enabled twice and then disabled once, and a stream is stalled after the disable Then
  `Writable.prototype.write` is the identical original function (`===`) after the disable, a read after the
  stall reports zero events, and while the probe was enabled a stall on an NDJSON exporter's destination
  created through the agent entrypoint is not counted in any read
  - verify: unit
- **AC-3** Given a sampler controller imported from the agent entrypoint and started with a short interval
  and a callback When one interval elapses and then `stop()` is called Then the callback's sample carries a
  `backpressure` part with total events, total stall, max stall and a hotspots list, every numeric field a
  non-negative integer, alongside the existing event loop, memory and gc parts; and after `stop()` returns,
  `Writable.prototype.write` is the original function again
  - verify: unit

## Constraints

- `src/agent` imports Node core modules only: zero third-party and zero workspace dependencies.
- No `async_hooks` import (reserved for the agent's context module).
- All reported numbers are integers; stall durations are integer nanoseconds.
- Stack capture happens at most once per stream (on its first stall), never on every `write()` call.
- No Node runtime flag is required; Node 22 or later, TypeScript strict mode, and the existing dual
  ESM/CJS build must keep compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for both unit and integration criteria, with
  per-test results already configured; the test stage's preflight decides whether that holds.
- N (the hotspot cap) has a fixed default chosen by the PLAN and may be configurable; the criteria only
  require the list never exceeds it.
- A stall still open (no `'drain'` yet) at read time is counted as an event in the window it started, and
  its duration is counted in the window in which it drains; the PLAN may refine this as long as AC-1's
  numbers hold.
- Two stalled streams created at the same site are aggregated under one hotspot entry.
- "Excluded from the probe" for the exporter destination means its stalls never appear in any reading;
  the PLAN chooses the mechanism (for example a marker set by the exporter).
- Exact exported names, sample field names and the controller's ownership of the probe are left to the
  PLAN, mirroring how the controller owns its GC sampler; calling `stop()` twice is a harmless no-op.
