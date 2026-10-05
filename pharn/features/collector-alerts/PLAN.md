---
spec_id: collector-alerts
spec_content_hash: f34f0ce5224b604af5b5de95b9ed78ab1e72d6bb9ae3bc51070f9478c03e91c2
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `collector-alerts` (ROADMAP S2, slice 2).

Discovery (live, this run): the repo is a single npm package (`"type": "module"`, dual ESM/CJS build via
`scripts/build.mjs`), vitest with `include: ['src/**/*.test.ts']`, `package.json` exports `./collector` from
`dist/{esm,cjs}/collector/index.js`. `src/collector/` holds the collector-windows slice: `window.ts`
(`AggregatedWindow` = `{ start; end; count; late; eventLoop: { max; p99; mean }; memory: { heapUsedLast;
heapUsedMax; rssLast; rssMax }; gc: { count; totalPause; maxPause }; backpressure: { events; totalStall;
maxStall } }`, all integers), `window-aggregator.ts` (`createWindowAggregator({ windowMs })`, object-mode
Transform), `ring-buffer.ts` (`createRingBuffer<T>(capacity)` with `push`, `snapshot`, `size`, `capacity`),
`collector.ts` (`createCollector({ windowMs, capacity })` → `{ windows, consume(source) }`, where `consume` runs
`pipeline(source, aggregator, async sink)` into the ring buffer) and `index.ts` (re-exports, keeps
`CollectorPlaceholder`). `eslint.config.mjs` restricts imports only under `src/agent/**`. The existing
`collector-windows.ac{1,2,3}.test.ts` drive `createWindowAggregator` and `createCollector({ windowMs, capacity })`.

Design (each file one axis of change):

1. **Alert rules** (`src/collector/alert-rules.ts`, new) — the rule vocabulary and its validation. Pure, no
   streams.
   - `ALERT_METRICS`: a frozen table `Record<AlertMetric, (w: AggregatedWindow) => number>` with exactly the 13
     paths of the SPEC's closed set (`eventLoop.max`, `eventLoop.p99`, `eventLoop.mean`, `memory.heapUsedLast`,
     `memory.heapUsedMax`, `memory.rssLast`, `memory.rssMax`, `gc.count`, `gc.totalPause`, `gc.maxPause`,
     `backpressure.events`, `backpressure.totalStall`, `backpressure.maxStall`). `AlertMetric` is the union of
     those string literals. Membership is `Object.hasOwn(ALERT_METRICS, metric)`, a deterministic test, so
     `start`, `end`, `count`, `late` and any other string are unknown.
   - Types `AlertComparison = '>' | '>='` and
     `AlertRule = { id: string; metric: AlertMetric; comparison: AlertComparison; threshold: number; forWindows?: number }`.
   - `validateAlertRules(rules: readonly AlertRule[]): ResolvedAlertRule[]` throws synchronously on the first bad
     rule, with a message that names the rule id (`alert rule "<id>": …`): a non-array input (`TypeError`), an
     id that is not a non-empty string (`TypeError`, named by its index since it has no usable id), an unknown
     metric (`RangeError`), a comparison other than `>` / `>=` (`RangeError`), a threshold that is not a safe
     non-negative integer (1.5, -1, NaN, a string → `RangeError`), a `forWindows` present but not a safe integer
     ≥ 1 (`RangeError`), and a duplicate id (`RangeError`, message names the repeated id). It returns frozen
     copies with `forWindows` defaulted to 1, so later mutation of the caller's objects cannot change
     evaluation. Inputs are typed loosely at runtime (read through `unknown`) because JS callers bypass the types.
   - `readAlertMetric(window, metric): number` returns `ALERT_METRICS[metric](window)`.
2. **Alert evaluator** (`src/collector/alert-evaluator.ts`, new) — the edge-triggered state machine as a stream.
   - Types `AlertState = 'firing' | 'resolved'` and
     `Alert = { ruleId: string; metric: AlertMetric; comparison: AlertComparison; threshold: number; observed: number; windowStart: number; windowEnd: number; state: AlertState }`.
   - `createAlertEvaluator(rules: readonly AlertRule[]): Transform` — calls `validateAlertRules` first (so it
     throws synchronously at creation), then returns a `node:stream` `Transform` with `objectMode: true`. State per
     rule, in rule order: `consecutive` (integer, capped at `forWindows`) and `firing` (boolean).
   - `transform(window)`: for each rule in the order given: `observed = readAlertMetric(window, metric)`; if
     `observed` is not a safe non-negative integer → `callback(new TypeError(…naming the rule id and metric…))`
     (surfaced, never coerced, so no float can reach an alert); `breach = comparison === '>' ? observed > threshold
     : observed >= threshold`. On breach and not firing: `consecutive = min(consecutive + 1, forWindows)`; when
     `consecutive === forWindows`, set firing and `push` a `firing` alert carrying this window's `start`/`end` and
     `observed`. On breach and firing: nothing. On no breach: `consecutive = 0`; if firing, clear it and `push` a
     `resolved` alert for this window. Exceptions are caught and passed to `callback(err)`.
   - No `flush` output: ending while firing emits no `resolved` (SPEC assumption).
3. **Collector** (`src/collector/collector.ts`, modified).
   - `CollectorOptions = { windowMs: number; capacity: number; alerts?: readonly AlertRule[] }`.
   - `Collector` gains `readonly alerts: RingBuffer<Alert>` (same `capacity` as `windows`, oldest first), so alert
     events are exposed alongside the windows ring buffer and the next slice (sinks) has a place to read them from.
   - `createCollector` validates eagerly: the existing aggregator/ring-buffer checks, plus
     `validateAlertRules(options.alerts ?? [])`, so a bad rule throws synchronously from `createCollector`.
   - `consume(source)` builds a fresh aggregator and a fresh `createAlertEvaluator(rules)` and runs one
     `pipeline()` from `node:stream/promises` — never `.pipe()`:
     `source → aggregator → recordWindows → evaluator → async sink(alerts.push)`, where `recordWindows` is a small
     object-mode pass-through `Transform` built in `collector.ts` that pushes each window into `windows` before
     passing it on (errors go to its callback). With no rules the evaluator emits nothing, so `windows` behaves
     exactly as before and `alerts` stays empty. Any stage error (source error, invalid sample, invalid observed
     value, an exception while recording) rejects `consume` with that error; nothing catches it.
4. **Entrypoint** (`src/collector/index.ts`, modified) — adds `createAlertEvaluator`, `validateAlertRules` and the
   types `Alert`, `AlertRule`, `AlertMetric`, `AlertComparison`, `AlertState`; keeps every existing export.

Constraints held by construction: Node core (`node:stream`, `node:stream/promises`) and relative imports only;
`src/agent` and `window.ts` / `window-aggregator.ts` are untouched; thresholds and observed values are checked to be
safe integers, comparisons are integer comparisons, and every alert field is copied from an integer, so no float is
emitted; a collector without rules keeps its behaviour (the collector-windows AC tests are unchanged).

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there are no
  lessons to apply.

## Steps

- Add `src/collector/alert-rules.ts` with `ALERT_METRICS`, the `AlertMetric`/`AlertComparison`/`AlertRule` types,
  `validateAlertRules` and `readAlertMetric`.
- Add `src/collector/alert-evaluator.ts` with the `Alert`/`AlertState` types and `createAlertEvaluator`.
- Extend `src/collector/collector.ts` with the `alerts` option, the `alerts` ring buffer and the four-stage
  `pipeline()`.
- Update `src/collector/index.ts` to re-export the new factories and types.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run check:exports`; run prettier on
  the written files.

## Files

- `src/collector/alert-rules.ts` — new. Closed alertable-metric table, rule types, synchronous rule validation that
  names the offending rule id, and the metric reader.
- `src/collector/alert-evaluator.ts` — new. `createAlertEvaluator(rules)`: object-mode Transform, AggregatedWindow
  in, edge-triggered `firing`/`resolved` Alert objects out, in rule order.
- `src/collector/collector.ts` — modified. Optional `alerts` rules option, `alerts: RingBuffer<Alert>` on the
  collector, and the source → aggregator → record windows → evaluator → alerts sink `pipeline()`.
- `src/collector/index.ts` — modified. Re-exports `createAlertEvaluator`, `validateAlertRules` and the alert types;
  existing exports kept.

### Explicitly not touched

- `src/agent/**` — out of scope per the SPEC.
- `src/collector/window.ts`, `src/collector/window-aggregator.ts`, `src/collector/ring-buffer.ts` — reused as is;
  the aggregator's output does not change.
- `src/collector/collector-windows.ac1.test.ts`, `src/collector/collector-windows.ac2.test.ts`,
  `src/collector/collector-windows.ac3.test.ts`, `src/collector/index.test.ts` — existing tests; they must keep
  passing unchanged.
- `vitest.config.mts`, `package.json`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`,
  `eslint.config.mjs`, `scripts/build.mjs` — test and build infrastructure, out of scope.

## Acceptance mapping

- **AC-1** (rules `heap` `memory.heapUsedMax >= 1000`, then `lag` `eventLoop.p99 > 100` forWindows 2; seven
  windows): `heap` breaches at start 1000 (1000 ≥ 1000, forWindows 1) → firing; 2000 still breaching → nothing;
  3000 (999) → resolved. `lag`: 0 (150) consecutive 1; 1000 (50) reset; 2000 (150) 1; 3000 (150) 2 → firing with
  observed 150; 4000 (200) nothing; 5000 (80) → resolved; 6000 (90) nothing. In window 3000 rule order puts `heap`
  resolved before `lag` firing, giving exactly the four alerts in the SPEC's order, each with
  `ruleId`, `metric`, `comparison`, `threshold`, `observed`, `windowStart`, `windowEnd`, `state`, all numbers
  integers.
- **AC-2** (each of: unknown metric, threshold 1.5, threshold -1, comparison `<`, forWindows 0, duplicate id —
  through `createAlertEvaluator` and through `createCollector({ …, alerts })`): both call `validateAlertRules`
  before building anything, which throws synchronously with `alert rule "<id>": …` in the message.
- **AC-3** (collector windowMs 1000, capacity 10, rule `eventLoop.max > 100`; samples across windows 0, 1000, 2000
  with max 50, 500, 50): `consume` resolves after the flush; `windows.snapshot()` has the three windows; the
  evaluator emits firing for 1000 and resolved for 2000, so `alerts.snapshot()` holds exactly those two in order. An
  erroring source makes `pipeline()` reject with that error, which `consume` returns unchanged.

## Risks & open questions

- **Exposure choice.** The SPEC left the mechanism open; this plan exposes alerts as a second ring buffer
  (`collector.alerts`, same `capacity` as `windows`) rather than a callback or a Readable. It is bounded and mirrors
  `windows`; the trade-off is that more than `capacity` alerts between reads drop the oldest. The next slice (sinks)
  may add a streaming hook. Flagged for `/pharn-grill`.
- **Names are plan choices** (`createAlertEvaluator`, `validateAlertRules`, `CollectorOptions.alerts`,
  `Collector.alerts`, alert fields `ruleId`, `metric`, `comparison`, `threshold`, `observed`, `windowStart`,
  `windowEnd`, `state`). The AC tests drive exactly these.
- **Error classes.** Validation throws `RangeError` for out-of-range values and `TypeError` for wrong shapes; the
  SPEC only requires a synchronous throw whose message contains the rule id, so tests should assert on the message,
  not the class.
- **Invalid observed values** (a hand-built window with a float or missing field) error the evaluator stream instead
  of being coerced. Windows from the aggregator are always integers, so the collector path never hits this.
- **The SPEC's callback-error assumption** does not arise: there is no callback; an exception in the record stage
  is passed to that stage's callback and rejects `consume`.
