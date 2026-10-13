---
spec_id: otel-span-batching
spec_content_hash: 450a23f040e311cc157dd34506cd45b9832cd30acd0db65475d9808c52ed5c29
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `otel-span-batching` (review finding F2, OTLP span
> loss). Everything below was read live this run.

Discovery (live, this run):

- `src/otel/otlp-batch-queue.ts` holds `T[][]` (one entry per `push`), bounded by `capacity` batches, and drops the
  NEWEST batch when full (`queue.length >= capacity` → `droppedBatches += 1`). `drainQueue()` shifts one batch at a
  time and awaits `sendBatch` (`encode(batch)` then `postOtlpJson`), so each `push` becomes one POST, one in flight.
  `close()` races `flush()` against `closeTimeoutMs`, then `dropQueued()` (one report naming "dropped N queued
  batch(es)") and aborts the in-flight request through `abortOnClose`. There is no timer.
- `src/otel/otlp-trace-exporter.ts` and `src/otel/otlp-exporter.ts` (metrics) both resolve options through
  `resolveOtlpExporterOptions` and build the queue with `capacity: queueCapacity`; their listeners (`span`, `window`)
  push one single-item batch per callback. Both expose `droppedBatches` and `failedBatches` getters only.
- `src/otel/otlp-exporter-options.ts` validates `timeoutMs` and `queueCapacity` with `requirePositiveSafeInteger`
  (a `RangeError` whose message starts with the option name) and `closeTimeoutMs` as non-negative; default
  `queueCapacity` 64.
- `src/otel/otlp-transport.ts` `postOtlpJson` never throws; it resolves `undefined` on 2xx and an `Error` otherwise
  (messages name status, "aborted by close()", timeouts). It is reused unchanged.
- `toOtlpTraces` / `toOtlpMetrics` already accept arrays and put every record in one
  `resourceSpans[0].scopeSpans[0].spans[]` / one metrics request, so coalescing needs no encoder change. Either one
  throws a `RangeError` for a malformed record, which today fails only that record's single-item batch.
- Existing tests that assert the old behaviour (one POST per export call, drop-newest, silent drops):
  `src/otel/otlp-bounds.integration.test.ts` (F-08: "dropped 10 queued batch" message; "drains a responsive endpoint
  completely" expects 8 requests), `src/otel/otel-trace-export.ac3.integration.test.ts` and
  `src/otel/otel-metrics-export.ac3.integration.test.ts` (third test: `queueCapacity: 1`, drop-newest, `errors`
  length 0). The `ac1` / `ac2` otel tests and the F-06 / other F-08 cases stay valid under the new behaviour.
- `bench/lib/soak-collector.mjs` passes `queueCapacity` and reads `droppedBatches` / `failedBatches`; both stay
  accepted and meaningful, so the bench keeps running unchanged.
- Docs: `docs/THREAT-MODEL.md` row F2 says "batches still queued are dropped and counted"; `FEATURES.md` line 59–60
  says "Bounded queue"; `README.md` has a one-line OpenTelemetry row; `CHANGELOG.md` has `## [Unreleased]` with only
  `### Changed`. Neither `LIMITS.md` nor `docs/LIMITS.md` mentions OTel (grep, this run), and `ARCHITECTURE.md`
  describes neither OTel options nor limits — so those three are not touched (SPEC Assumptions, last bullet).

Design (Node core only; `src/otel` keeps importing only types from `../collector/index.js`):

1. **Pending items** (`src/otel/otlp-pending-items.ts`, new) — a fixed-capacity FIFO ring of entries
   `{ item: T; call: ExportCall }`, where `ExportCall = { dropped: boolean }` is one small object per export call
   (listener callback or `export()`), shared by that call's items. Operations: `push(entry)` (when full, evicts and
   returns the OLDEST entry, O(1)), `take(n)` (removes and returns up to `n` oldest entries, in order), `clear()`
   (removes and returns all), `size`. Head index + modulo, no `Array.shift` on the hot path. Pure data structure: no
   timers, no I/O, no counters.
2. **Drop reporter** (`src/otel/otlp-drop-reporter.ts`, new) — rate-limited reporting of dropped items:
   `createDropReporter({ intervalMs, report, describe })` → `{ add(count: number): void; flushNow(): void;
   dispose(): void }`. `add` accumulates an integer `unreported`; when no report was made within the last
   `intervalMs` it reports at once (so the first drop is prompt), otherwise it arms one `unref()`ed timer for the end
   of the window that reports the aggregated count. `flushNow()` reports any unreported count immediately (used by
   `flush()` and `close()`). Each report is ONE `Error` whose message contains `dropped <n> item(s)` plus the origin
   (never the path, query or headers), produced by `describe(n)`. `report` is the queue's existing `report()`
   (onError, falling back to `process.emitWarning`, and to `emitWarning` when onError throws). So a burst of drops
   produces a handful of reports, never one per item, and never none.
3. **Batch queue** (`src/otel/otlp-batch-queue.ts`, rewritten) — item-level batching:
   - Options: `maxBatchSize`, `maxQueueSize`, `flushIntervalMs`, `encode(batch: readonly T[]): string`, `target`,
     `closeTimeoutMs`, `onError`. `capacity` is removed. Effective batch size = `min(maxBatchSize, maxQueueSize)`
     (SPEC Assumptions).
   - `push(items)` (synchronous, never throws): copy; empty → ignore; one `ExportCall` per push. If closed → every
     item is dropped (counters below), `droppedBatches += 1`, `reporter.add(n)`, return. Otherwise append each item to
     the pending ring; every evicted entry increments `droppedItems` and, the first time for its call,
     `call.dropped = true; droppedBatches += 1`; evictions go to `reporter.add`. Then: if nothing is in flight and
     `pending.size >= batchSize` → start a send; else if `pending.size > 0` and no timer is armed → arm the flush timer.
   - Flush timer: one `setTimeout(flushIntervalMs)`, always `unref()`ed, armed only while items are pending (so an idle
     exporter holds no timer — AC-9). On fire: mark "send what is pending" and start the drain loop if idle. The delay
     is clamped to `2_147_483_647` ms (the largest `setTimeout` accepts) so a very large valid value never turns into a
     1 ms timer.
   - Drain loop (one at a time, so never two requests open at once): while there is due work — `pending.size >=
     batchSize`, a timer fire not yet served, or a flush/close in progress with items pending — `take(batchSize)` and
     send one coalesced request. After each request: if `pending.size >= batchSize`, continue immediately; else if items
     remain and no timer is armed, arm it. Every path of the loop is inside `try`/`catch`/`finally`; nothing it does can
     reject unobserved (the promise is held in `drain` and every starter attaches to it).
   - Send: `encode(entries.map(e => e.item))`. If `encode` throws, isolate the bad records: encode each item alone
     (`encode([item])` in a `try`), count the ones that throw as `failedItems` and one `failedBatches`, report one
     `Error` (the first cause's message, which names the field, never the value), and encode the rest into one body
     — so a malformed record still costs only itself, as before coalescing. Then `postOtlpJson(target, body,
     abortOnClose.signal)`: `undefined` → `exportedItems += n`; an `Error` → `failedBatches += 1`,
     `failedItems += n`, `report(error)`.
   - `flush()`: requests that everything pending at the call is sent now (batches of `batchSize`, back to back),
     awaits the drain loop including the request in flight, then `reporter.flushNow()`. Never rejects.
   - `close()` (idempotent, the same promise): `closed = true`; clear the flush timer; flush everything pending, raced
     against a `closeTimeoutMs` deadline. On timeout: `pending.clear()` → each entry counted in `droppedItems` /
     `droppedBatches` (per call, once), one immediate report naming "close() timed out after <ms>ms; dropped <n>
     item(s)"; then `abortOnClose.abort()` (the in-flight request becomes a failed request: `failedBatches` 1,
     `failedItems` its size) and await the loop. Finally `reporter.flushNow()`. Export calls after close are dropped
     and counted (push, above) and reported through the reporter, whose timer is `unref()`ed.
   - Counters (integers, only `+=`): `droppedBatches`, `failedBatches`, `droppedItems`, `exportedItems`, `failedItems`.
     Memory: at most `maxQueueSize` pending items plus the items of the one request in flight.
4. **Options** (`src/otel/otlp-exporter-options.ts`) — `OtlpExporterOptions` gains `flushIntervalMs?` (default 1000),
   `maxBatchSize?` (default 512), `maxQueueSize?` (default 2048), each validated with `requirePositiveSafeInteger`
   (so `0`, `-1`, `1.5`, `NaN` → `RangeError` naming the option). `queueCapacity?` stays accepted and validated as
   before (positive safe integer, else `RangeError` naming `queueCapacity`), carries a `@deprecated` JSDoc saying it
   no longer bounds anything and that `maxQueueSize` (items) is the bound, and is not mapped onto `maxQueueSize`
   (different units). `ResolvedOtlpExporterOptions` drops `queueCapacity` and gains the three resolved values.
   Constants named (`DEFAULT_FLUSH_INTERVAL_MS`, `DEFAULT_MAX_BATCH_SIZE`, `DEFAULT_MAX_QUEUE_SIZE`), no magic values.
5. **Exporters** (`src/otel/otlp-trace-exporter.ts`, `src/otel/otlp-exporter.ts`) — pass the three resolved options
   to the queue; add `droppedItems`, `exportedItems`, `failedItems` getters beside the existing two; update the JSDoc
   of `export` / `flush` / `close` / `listener` (items are batched; one request per batch; drop-oldest; call
   `close()` or `flush()` before exit). Listener behaviour is otherwise unchanged (`span` / `window` push one item).
6. **Existing tests updated deliberately** (SPEC Scope):
   - `src/otel/otlp-bounds.integration.test.ts` — F-08 first case: the drop message assertion becomes
     `dropped 10 item(s)` (with `close() timed out`), `droppedBatches` 10 stays, and add `droppedItems` 10; the
     "drains a responsive endpoint completely" case now expects ONE request carrying all 8 windows, `droppedItems` 0,
     `exportedItems` 8. The other cases keep their assertions (they hold under batching; the first request now waits
     for the 1000 ms timer, inside `until`'s 5000 ms).
   - `src/otel/otel-trace-export.ac3.integration.test.ts` and `src/otel/otel-metrics-export.ac3.integration.test.ts`
     — the third case becomes drop-OLDEST with `maxQueueSize: 1, maxBatchSize: 1`: export 1 (sent, held), export 2,
     export 3 (evicts 2), release, flush → 2 requests, `droppedBatches` 1, `droppedItems` 1, and `errors` holds one
     `Error` whose message contains "dropped" (drops are no longer silent). Test titles say so. The 500 and
     connection-error cases are unchanged.
7. **Docs** — `docs/THREAT-MODEL.md` F2: batching, bounded drop-oldest `maxQueueSize`, item counters, rate-limited
   drop reports, unref'd timer, and the residual "items pending at exit without `close()`/`flush()` are not
   delivered"; cite the new AC test files beside `otlp-bounds.integration.test.ts`. `FEATURES.md`: "Bounded queue" →
   batched sends, bounded drop-oldest queue with counted, reported loss. `README.md` OpenTelemetry row: batched,
   bounded, loss counted. `CHANGELOG.md`: add `### Fixed` under `## [Unreleased]` describing F2, the three new
   options and their defaults, the new counters, drop-oldest, and `queueCapacity` deprecated. No version bump.

## Applied lessons

- none — `check-lessons-index.mjs --verdict` printed `NO_CANON`: this project has no `memory-bank/lessons-learned.md`
  yet, so there is no lesson to apply.

## Steps

- Add `src/otel/otlp-pending-items.ts` (ring with drop-oldest eviction, `take`, `clear`, `size`).
- Add `src/otel/otlp-drop-reporter.ts` (rate-limited aggregated drop reports, unref'd timer, `flushNow`, `dispose`).
- Rewrite `src/otel/otlp-batch-queue.ts` around the two (timer, drain loop, coalesced send, encode isolation,
  flush, bounded close, five counters).
- Extend `src/otel/otlp-exporter-options.ts` with the three options, defaults, validation and the `queueCapacity`
  deprecation note.
- Wire both exporters to the new options and expose the three new counters.
- Update the three existing otel test files as described in Approach §6.
- Update `docs/THREAT-MODEL.md` F2, `FEATURES.md`, `README.md` and `CHANGELOG.md`.
- Run `npx prettier --write` on every touched file, then `npm run build`, `npm run check:exports`,
  `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`.

## Files

- `src/otel/otlp-pending-items.ts` — new: bounded drop-oldest FIFO ring of pending items with per-call drop tracking
- `src/otel/otlp-drop-reporter.ts` — new: rate-limited, aggregated reporting of dropped items (unref'd timer)
- `src/otel/otlp-batch-queue.ts` — item-level batching: time and size triggers, one request in flight, item counters, encode isolation, flush and close
- `src/otel/otlp-exporter-options.ts` — `flushIntervalMs`, `maxBatchSize`, `maxQueueSize` with defaults and validation; `queueCapacity` kept, validated, deprecated
- `src/otel/otlp-trace-exporter.ts` — pass the new options to the queue; `droppedItems`, `exportedItems`, `failedItems` getters; JSDoc
- `src/otel/otlp-exporter.ts` — the same for the metrics exporter
- `src/otel/otlp-bounds.integration.test.ts` — F-08 assertions updated to the batched, item-counted behaviour
- `src/otel/otel-trace-export.ac3.integration.test.ts` — third case updated from drop-newest to drop-oldest with a reported drop
- `src/otel/otel-metrics-export.ac3.integration.test.ts` — the same for metrics
- `docs/THREAT-MODEL.md` — row F2 describes batching, drop-oldest bound, counters, reporting and the exit residual
- `FEATURES.md` — OTel bullet: batched, bounded drop-oldest queue, counted and reported loss
- `README.md` — OpenTelemetry row: batched, bounded, loss counted
- `CHANGELOG.md` — `### Fixed` entry under `## [Unreleased]`

### Explicitly not touched

- `src/otel/index.ts` — every new member is on the already-exported exporter and option types
- `src/otel/otlp-transport.ts` — `postOtlpJson` reused unchanged
- `src/otel/otlp-traces.ts` — `toOtlpTraces` already coalesces an array into one request
- `src/otel/otlp-metrics.ts` — `toOtlpMetrics` already coalesces an array into one request
- `src/otel/otlp-types.ts` — unchanged
- `src/otel/otlp-trace-types.ts` — unchanged
- `src/otel/otel-trace-export.ac1.test.ts` — pure conversion test, unaffected
- `src/otel/otel-trace-export.ac2.integration.test.ts` — still holds (at least one POST, both ids, no drops)
- `src/otel/otel-metrics-export.ac1.test.ts` — pure conversion test, unaffected
- `src/otel/otel-metrics-export.ac2.integration.test.ts` — still holds (one export call of two windows, one POST)
- `src/agent/` — out of scope (SPEC)
- `src/collector/` — out of scope (SPEC); only its types are imported, as today
- `bench/lib/soak-collector.mjs` — `queueCapacity` stays accepted and the counters it reads keep their meaning
- `ARCHITECTURE.md` — describes neither OTel options nor limits
- `LIMITS.md` — no OTel content
- `docs/LIMITS.md` — no OTel content (SPEC Assumptions)
- `package.json` — no dependency and no version bump
- `package-lock.json` — unchanged

## Acceptance mapping

- AC-1 (500 spans, ≤5 POSTs, coalesced, each id once, zero drops/failures, `exportedItems` 500) → default
  `maxBatchSize` 512 > 500, so the 500 listener pushes stay pending (no timer fire inside one synchronous loop) and
  `flush()` sends them as one coalesced `spans[]`; counters per Approach §3.
- AC-2 (size trigger, order, one in flight) → `push` starts a send at `pending.size >= 10`; the drain loop continues
  straight into ids 11–20 when request 1 completes because 15 ≥ 10; the last 5 wait for the 60 000 ms timer until
  `flush()`; one drain loop means one request open at a time.
- AC-3 (timer trigger) → the unref'd timer armed at the first push fires after 1000 ms and sends all 3 in one POST.
- AC-4 (drop-oldest, counts, ≤5 reports) → `maxQueueSize` 5 ring evicts s5…s99 one by one (95 items, 95 calls);
  the reporter reports the first drop at once and the aggregated rest at `flush()` — 2 reports containing "dropped".
- AC-5 (metrics) → the metrics exporter shares the queue: (a) 100 windows → one request at flush; (b) ring of 4 keeps
  w11–w14, `droppedItems` 6.
- AC-6 (close flushes, later export dropped, idempotent) → `close()` flushes the 3 pending items in one POST; a push
  after close is dropped and counted; the second `close()` returns the same resolved promise.
- AC-7 (bounded close on a hung endpoint) → the race hits `closeTimeoutMs` 200: 3 pending dropped and reported
  ("dropped"), the in-flight request aborted (`failedBatches` 1, `failedItems` 2), one request total.
- AC-8 (500 and refused connection) → `postOtlpJson` returns an `Error`; the queue counts `failedBatches` 1,
  `failedItems` 3, reports it; the drain loop never rejects, so no `unhandledRejection`.
- AC-9 (process exits) → no timer exists while nothing is pending, and every timer the queue or reporter arms is
  `unref()`ed.
- AC-10 (validation) → `requirePositiveSafeInteger` for the three new options; `queueCapacity` keeps its validation
  and is otherwise ignored.

## Risks & open questions

- Behaviour change for callers: one export call no longer means one request, and the first send now waits up to
  `flushIntervalMs` (1 s) unless a full batch is pending. Called out in `CHANGELOG.md` and the JSDoc.
- Items pending at process exit without `close()`/`flush()` are lost (unref'd timer) — a documented limit in
  THREAT-MODEL F2, as the SPEC decides.
- `flush()` under a continuous stream of pushes could keep sending; the build should bound it to the items pending at
  the call (a snapshot count), so `flush()` always terminates.
- Encode isolation re-encodes items one by one only on the error path; the happy path encodes each batch once.
- The drain loop starts synchronously inside `push` when a full batch is pending (as the current queue does), so
  `encode` of up to 512 items runs in the collector listener's call stack; acceptable for now, noted for the
  performance griller.
- `bench/lib/soak-collector.mjs` still passes the deprecated `queueCapacity`; its flood is now bounded by the default
  `maxQueueSize` 2048 items instead. Not changed here (bench is outside the SPEC's scope list).
