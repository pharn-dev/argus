---
spec_id: collector-alerts
state: Approved
spec_content_hash: f34f0ce5224b604af5b5de95b9ed78ab1e72d6bb9ae3bc51070f9478c03e91c2
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S2 (collector pipeline), slice 2: window-based alerts with per-metric thresholds (FEATURES.md
§8, "Window-based alerts emitted from the pipeline" and "Alert thresholds configurable per metric"). The
collector already condenses the agent's raw samples into aggregated time windows and keeps the most recent
ones in a ring buffer. A user diagnosing a live process needs to be told when a metric crosses a limit they
chose (for example event-loop p99 lag or heap usage), once when it starts and once when it recovers, not on
every window while it stays bad. This slice adds an alert evaluator to the collector pipeline, driven by
validated per-metric rules, so the next slice (alert sinks: stdout, file, webhook) has alert events to
deliver.

## Scope

**In scope:**

- An alert evaluator as an object-mode Transform stream placed after the window aggregator: it takes
  aggregated windows in and emits alert events out.
- Alert rules, one per metric threshold: a rule id, a metric path from a closed set of the aggregated
  window's metric fields (for example `eventLoop.p99`, `memory.heapUsedMax`, `gc.maxPause`,
  `backpressure.totalStall`), a comparison of `>` or `>=`, a non-negative integer threshold, and an optional
  `forWindows` count of consecutive breaching windows needed before firing (default 1).
- Edge-triggered alerting: one `firing` alert when a rule has breached for `forWindows` consecutive
  windows, nothing while it stays breached, and one `resolved` alert on the first non-breaching window after
  firing. Each alert carries the rule id, metric, comparison, threshold, observed integer value, the window
  start and end, and the state.
- Rule validation at construction: an unknown metric, a non-integer or negative threshold, a comparison
  other than `>` or `>=`, a `forWindows` below 1, or a duplicate rule id is rejected with an error naming
  the offending rule; an invalid rule is never silently ignored.
- `createCollector` gains an optional alert rules option and exposes the alert events alongside its
  windows ring buffer, still composed with `stream/promises` `pipeline()` and with explicit error handling.
- Everything exported from `src/collector/index.ts`, with vitest tests.

**Out of scope (non-goals):**

- Alert sinks or delivery of any kind (stdout, file, webhook, SSE); that is the next slice.
- Rules over anything other than a single aggregated-window metric compared with a constant (no
  expressions, rates, combinations of metrics, or user code; user rules in a sandbox belong to the plugin
  runner).
- Comparisons other than `>` and `>=`, and hysteresis or a separate recovery threshold.
- Changing rules at runtime, alert deduplication across collectors, or persisting alert state.
- Any change to `src/agent` or to the window aggregator's output.

## Acceptance Criteria

- **AC-1** Given an alert evaluator imported from the collector entrypoint with two rules given in this
  order, rule `heap` on `memory.heapUsedMax` with `>=` 1000 and no `forWindows`, then rule `lag` on
  `eventLoop.p99` with `>` 100 and `forWindows` 2 When seven aggregated windows (starts 0, 1000, …, 6000, each with end equal to start
  plus 1000) are written to it in order with event-loop p99 values 150, 50, 150, 150, 200, 80, 90 and
  heapUsedMax values 999, 1000, 1000, 999, 999, 999, 999, and the stream is ended Then exactly four alert
  objects are read from it, in this order: `heap` firing with observed 1000 for the window starting 1000;
  `heap` resolved with observed 999 for the window starting 3000; `lag` firing with observed 150 for the
  window starting 3000; and `lag` resolved with observed 80 for the window starting 5000; and each alert
  carries its rule id, metric path, comparison, threshold, the observed value, the window's start and end,
  and its state, with every numeric field an integer
  - verify: unit
- **AC-2** Given the collector entrypoint When an alert evaluator, or a collector with alert rules, is
  created with a rule set containing one invalid rule, for each of: an unknown metric path, a threshold of
  1.5, a threshold of -1, a comparison of `<`, a `forWindows` of 0, and two rules sharing one id Then
  creation throws synchronously, and the thrown error's message contains the id of the offending rule
  - verify: unit
- **AC-3** Given a collector created from the collector entrypoint with `windowMs` 1000, capacity 10 and one
  alert rule on `eventLoop.max` with `>` 100 When it consumes a readable source of agent samples spanning
  three consecutive windows whose event-loop max values are 50, 500 and 50, and the source ends Then its
  completion resolves, its windows ring buffer snapshot holds the three windows, and exactly two alert
  events are observable from the collector, a firing alert for the window starting 1000 followed by a
  resolved alert for the window starting 2000; and when a collector with alert rules consumes a readable
  source that errors Then its completion rejects with that source's error
  - verify: unit

## Constraints

- `src/collector` uses Node core modules only (no third-party dependencies); `src/agent` never imports
  from `src/collector`.
- Stream composition uses `stream/promises` `pipeline()`, never `.pipe()`; every stream error is surfaced
  explicitly, never swallowed.
- Alert evaluation is integer math: thresholds and observed values are integers, and no float appears in
  an emitted alert.
- A collector created without alert rules keeps its existing behaviour (the collector-windows criteria
  still hold).
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build must keep
  compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these unit criteria, with per-test results
  already configured; the test stage's preflight decides whether that holds.
- The closed metric set is every numeric metric field under the window's `eventLoop`, `memory`, `gc` and
  `backpressure` groups (`eventLoop.max`, `eventLoop.p99`, `eventLoop.mean`, `memory.heapUsedLast`,
  `memory.heapUsedMax`, `memory.rssLast`, `memory.rssMax`, `gc.count`, `gc.totalPause`, `gc.maxPause`,
  `backpressure.events`, `backpressure.totalStall`, `backpressure.maxStall`); `start`, `end`, `count` and
  `late` are not alertable.
- A threshold must be a safe non-negative integer (0 allowed); `forWindows` must be a safe integer of 1 or
  more; a rule id must be a non-empty string. A rule failing any of these is rejected the same way as the
  listed cases.
- A breach is `observed > threshold` or `observed >= threshold` per the rule's comparison; any
  non-breaching window resets the consecutive-breach count, including before the rule has fired.
- A `firing` alert carries the window that completed the `forWindows` run and its observed value; a
  `resolved` alert carries the first non-breaching window and its observed value.
- Within one window, alerts are emitted in the order the rules were given.
- Ending the stream while a rule is firing emits no `resolved` alert; the rule simply stops being
  evaluated.
- How the collector exposes alert events (an object-mode Readable, an `onAlert` callback or equivalent),
  exact exported names and the alert object's field names are left to the PLAN; the criteria only require
  them to be reachable from the collector entrypoint.
- An error thrown while delivering an alert to a collector consumer (for example by a callback) rejects the
  collector's completion rather than being swallowed.
