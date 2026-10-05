---
spec_id: collector-windows
state: Approved
spec_content_hash: 9342a6f9e40a234724bf174a29e016a29738b05d7ab059d80b29afed60d69bec
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S2 (collector pipeline), slice 1: aggregated time windows plus an in-memory ring buffer. The
agent already emits one raw sample per sampling interval (event loop lag, memory, GC, backpressure). A
dashboard or alert rule needs those raw samples condensed into fixed, aligned time windows, and needs the
most recent windows held in bounded memory so they can be read at any time. This slice replaces the
collector's scaffold placeholder in `src/collector` with a window aggregator stream, a ring buffer of recent
windows, and a collector that composes them, so later S2 slices (alerts, sinks, disk persistence) have
aggregated windows to build on.

## Scope

**In scope:**

- A window aggregator as an object-mode Transform stream over the agent's raw samples (`AgentSample` from
  `src/agent`). It groups samples into fixed, aligned windows of `windowMs`, where a sample's window start
  is `floor(timestamp / windowMs) * windowMs`, and emits one aggregated window object per closed window.
- Each aggregated window carries at least: window start and end, sample count, event-loop lag max of the
  samples' max, max of the samples' p99 and the integer mean of the samples' means, memory heapUsed and rss
  as both the last value and the max value, GC count and total pause summed with the max single pause, and
  backpressure events and total stall summed with the max single stall.
- Window closing: a window closes when a sample arrives for a later window; ending the stream emits the
  last open window.
- Late samples: a sample older than the open window is counted in an integer `late` counter on the next
  window emitted and is otherwise dropped; a closed window is never re-opened or re-emitted.
- A ring buffer of the most recent N windows, bounded in memory (the oldest is evicted), readable as an
  array snapshot ordered newest-last, fed by the aggregator's output.
- A collector factory (for example `createCollector({ windowMs, capacity })`) that composes the aggregator
  and ring buffer with `stream/promises` `pipeline()`, surfaces errors explicitly, and exposes the ring
  buffer.
- Everything exported from `src/collector/index.ts`, with vitest tests.

**Out of scope (non-goals):**

- Alerts, alert rules and thresholds.
- Sinks, SSE, NDJSON parsing or any network or file output.
- Disk persistence of windows.
- Aggregating per-kind GC counts or per-site backpressure hotspots across samples.
- Any change to `src/agent`.

## Acceptance Criteria

- **AC-1** Given a window aggregator imported from the collector entrypoint with `windowMs` 1000 When it is
  written, in timestamp order, three samples with timestamps 1000, 1400 and 1999 (event-loop means 10, 11
  and 11, distinct max and p99 values, increasing then decreasing heapUsed and rss, GC and backpressure
  counts and stalls), then one sample at 2500, and then the stream is ended Then exactly two window objects
  are read from it, in order: the first, emitted once the 2500 sample is written, has start 1000, end 2000,
  sample count 3, event-loop max equal to the largest sample max, p99 equal to the largest sample p99 and
  mean equal to 10 (floor of 32 / 3), memory last heapUsed and rss equal to the 1999 sample's values and max
  heapUsed and rss equal to the largest values seen, GC count and total pause equal to the sums with max
  pause equal to the largest single max pause, backpressure events and total stall equal to the sums with
  max stall equal to the largest single max stall, and `late` 0; the second, emitted on end, has start 2000,
  end 3000 and sample count 1; and every numeric field of both windows is an integer
  - verify: unit
- **AC-2** Given a window aggregator with `windowMs` 1000 that has received a sample at 2100 (so the window
  starting at 1000 has already been emitted after a sample at 1500 and the window starting at 2000 is open)
  When two samples with timestamps 1200 and 900 are then written, followed by a sample at 2200 and a sample
  at 3100, and the stream is ended Then no second window with start 1000 and no window with start 0 is
  ever emitted, the window starting at 2000 reports sample count 2 (the 2100 and 2200 samples only) and
  `late` 2, and the window starting at 3000 reports `late` 0
  - verify: unit
- **AC-3** Given a collector created from the collector entrypoint with `windowMs` 1000 and capacity 2 When
  it consumes a readable source of samples spanning four consecutive windows (starts 0, 1000, 2000 and
  3000) and the source ends Then its completion resolves and its ring buffer snapshot is an array of
  exactly two windows with starts 2000 then 3000 (newest last); and when another collector consumes a
  readable source that errors Then its completion rejects with that source's error
  - verify: unit

## Constraints

- `src/collector` uses Node core modules only (no third-party dependencies); it may import types and values
  from `src/agent`, and `src/agent` never imports from `src/collector`.
- Stream composition uses `stream/promises` `pipeline()`, never `.pipe()`; every stream error is surfaced
  explicitly, never swallowed.
- All aggregation is integer math: sums, maxima and an integer mean using floor division; no float values
  appear in an emitted window.
- The ring buffer's memory is bounded by its capacity regardless of how many windows pass through it.
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build must keep
  compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these unit criteria, with per-test results
  already configured; the test stage's preflight decides whether that holds.
- The stated rounding for the event-loop mean of means is floor (integer division truncating toward zero,
  inputs being non-negative), and the mean is an unweighted mean over the window's samples.
- A window's end is its start plus `windowMs` (exclusive end).
- "Late" means a timestamp before the open window's start; a sample with the open window's start or later
  in the same window is not late. When no window is open yet, no sample is late.
- "On the next window" means the next window the aggregator emits, which is the window open when the late
  sample arrived.
- Samples whose timestamp lies in a later window than the next one (a gap) simply open that later window;
  no empty windows are emitted for the gap.
- Exact exported names, field names of the window object, the ring buffer's API and how the collector's
  completion is exposed (a promise or equivalent) are left to the PLAN; the criteria only require them to
  be reachable from the collector entrypoint.
- The scaffold placeholder type and its test in `src/collector` may be removed or replaced by this slice.
