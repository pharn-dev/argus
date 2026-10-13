---
spec_id: otel-span-batching
state: Approved
spec_content_hash: 450a23f040e311cc157dd34506cd45b9832cd30acd0db65475d9808c52ed5c29
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
---

## Intent

Review finding F2 (High) in the `@pharn-dev/phargus/otel` module: OTLP trace export loses most spans
under real traffic. The trace exporter's listener queues one batch per span, the shared batch queue
sends one batch per request, one request at a time, and when its capacity of pending batches (default
64) is full it drops the NEWEST batch. A probe that emitted 500 spans through the listener against a
local OTLP endpoint with 5 ms latency saw 65 POSTs, 65 spans delivered and 435 dropped. So a user who
points Phargus at their OpenTelemetry backend sees a small, old-biased sample of their spans, and the
collector receives one HTTP request per span. The metrics exporter shares the same queue and has the
same shape of loss for windows.

The user wants both OTLP exporters to batch: pending items (spans, windows) are coalesced into one
OTLP/HTTP JSON request, sent on a timer or as soon as a full batch is pending, with one request in
flight at a time; the number of pending items is bounded, and when it overflows the OLDEST items are
dropped, never the newest; every lost item is counted and reported, so loss stays visible; and the
exporter's timer never keeps the host process alive, while `flush()` and `close()` still deliver what is
pending.

## Scope

**In scope:**

- Time- and size-based batching in the queue shared by the trace exporter and the metrics exporter: a
  send happens at most every `flushIntervalMs` (new option, default 1000) or as soon as `maxBatchSize`
  items (new option, default 512) are pending, and each send coalesces up to `maxBatchSize` pending
  items into ONE OTLP/HTTP JSON request (several spans in one `resourceSpans[].scopeSpans[].spans[]`;
  several windows in one metrics request), with one request in flight at a time.
- A bound on pending items, `maxQueueSize` (new option, default 2048 items): on overflow the oldest
  pending items are dropped.
- Item-level counters on both exporters, `droppedItems`, `exportedItems` and `failedItems` (integers that
  only grow), alongside the existing `droppedBatches` and `failedBatches`, which keep working.
- Reporting dropped items through the error callback, or `process.emitWarning` when there is none, in a
  rate-limited way: never silent, never one report per dropped item.
- A flush timer that is `unref()`ed; `flush()` that sends everything pending immediately and awaits the
  request in flight; `close()` that stops accepting items, flushes everything pending within the existing
  `closeTimeoutMs`, then drops (counting and reporting) what remains and aborts the request in flight;
  idempotent.
- Validation of the three new options like the existing ones (positive safe integers, `RangeError`
  otherwise), and a deliberate, documented decision for the existing `queueCapacity` option.
- Updating the existing otel tests that asserted one request per export call or drop-newest behaviour,
  deliberately, to the new behaviour.
- Documentation: README, `docs/` (including `docs/THREAT-MODEL.md` row F2, and `docs/LIMITS.md` if it
  describes OTel queue limits), `FEATURES.md` and `ARCHITECTURE.md` where OTel export options or limits
  are described, and an entry under `## [Unreleased]` → `### Fixed` in `CHANGELOG.md`.

**Out of scope (non-goals):**

- Any other review finding, including span `parentSpanId` export.
- Retries with backoff, persistence of unsent items, compression, gRPC or protobuf encoding.
- Delivering pending items at process exit without `close()` being called (no `beforeExit` or exit hook).
- Any change to `src/agent`, the collector, the dashboard, the analyzer or the plugin runner.
- Bumping the package version.
- Any third-party runtime dependency.

## Acceptance Criteria

- **AC-1** Given a local HTTP server on 127.0.0.1 that answers every POST with 200 after a 5 ms delay,
  and a trace exporter created from the otel module entrypoint with that server's URL, default batching
  options and an error callback When 500 span records with distinct span ids are passed one at a time to
  `exporter.listener.span` and then `exporter.flush()` resolves Then the server has received at most 5
  POST requests, at least one request body holds more than one span in a single
  `resourceSpans[].scopeSpans[].spans[]` array, the bodies together contain each of the 500 span ids
  exactly once, `droppedItems` is 0, `droppedBatches` is 0, `failedBatches` is 0, `exportedItems` is
  500, and the error callback was never called
  - verify: integration
- **AC-2** Given a local HTTP server on 127.0.0.1 that answers 200 and records how many requests are
  open at once, and a trace exporter with `maxBatchSize` 10 and `flushIntervalMs` 60000 When 25 span
  records are passed one at a time to `exporter.listener.span`, the test waits up to 2000 ms without
  calling flush, and then `exporter.flush()` resolves Then before the flush the server had received
  exactly two POSTs, each holding exactly 10 spans, which together are the first 20 span ids in the
  order passed; after the flush it has received a third POST holding exactly the last 5 span ids; and
  at no time were two requests open at once
  - verify: integration
- **AC-3** Given a local HTTP server on 127.0.0.1 that answers 200 and a trace exporter with default
  batching options When 3 span records are passed to `exporter.listener.span` and neither flush nor
  close is called Then within 2500 ms the server receives exactly one POST, whose body holds exactly
  those 3 span ids
  - verify: integration
- **AC-4** Given a local HTTP server on 127.0.0.1 that holds its first request open until the test
  releases it and answers every other request 200, and a trace exporter with `maxQueueSize` 5,
  `maxBatchSize` 5, `flushIntervalMs` 60000 and an error callback When span records s0 to s4 are passed
  one at a time to `exporter.listener.span`, the server has received the first request, span records s5
  to s104 are then passed one at a time, the held request is released and `exporter.flush()` resolves
  Then the request bodies together contain exactly the span ids of s0 to s4 and s100 to s104 and none of
  s5 to s99; `droppedItems` is the integer 95; `droppedBatches` is the integer 95; `exportedItems` is 10;
  and the error callback received at least 1 and at most 5 `Error`s whose message contains "dropped"
  - verify: integration
- **AC-5** Given a metrics exporter created from the otel module entrypoint When (a) against a 127.0.0.1
  server that answers 200 after 5 ms, with default batching options, 100 aggregated windows with
  distinct end times are passed one at a time to `exporter.listener.window` and flush resolves, and (b)
  against a 127.0.0.1 server that holds its first request open until released, with `maxQueueSize` 4,
  `maxBatchSize` 4 and `flushIntervalMs` 60000, windows w1 to w4 are passed one at a time, the server
  has received the first request, windows w5 to w14 are passed one at a time, the held request is
  released and flush resolves Then in (a) the server received at most 5 POSTs whose
  `phargus.event_loop.lag.max` data points carry, as `timeUnixNano`, each of the 100 window end times
  (in nanoseconds) exactly once, and `droppedItems` is 0; and in (b) those data points carry exactly the
  end times of w1 to w4 and w11 to w14, and `droppedItems` is the integer 6
  - verify: integration
- **AC-6** Given a local HTTP server on 127.0.0.1 that answers 200 and a trace exporter with
  `flushIntervalMs` 60000 When 3 span records are passed to `exporter.listener.span`, `exporter.close()`
  is called without a flush, and after it resolves one more span record is passed to the listener and
  `exporter.close()` is called again Then when the first close resolves the server has received exactly
  one POST holding exactly those 3 span ids; the later span id is never received; `droppedItems` is 1;
  and both close calls resolve without throwing
  - verify: integration
- **AC-7** Given a local HTTP server on 127.0.0.1 that accepts requests and never answers, and a trace
  exporter with `maxBatchSize` 2, `flushIntervalMs` 60000, `closeTimeoutMs` 200 and an error callback
  When 2 span records are passed to `exporter.listener.span`, the server has received that request, 3
  more span records are passed, and `exporter.close()` is called Then close resolves within 2000 ms
  without throwing; the server received exactly one request; `droppedItems` is 3, `failedItems` is 2 and
  `failedBatches` is 1; and the error callback received an `Error` whose message contains "dropped"
  - verify: integration
- **AC-8** Given a trace exporter with an error callback, and a listener on the process
  `unhandledRejection` event When (a) 3 span records are passed to `exporter.listener.span` with the
  exporter pointed at a 127.0.0.1 server that answers 500 and flush is called, and (b) the same is done
  with the exporter pointed at a 127.0.0.1 port with no listener Then in both cases the listener calls
  and the flush neither throw nor reject, `failedBatches` is 1, `failedItems` is 3, `exportedItems` is 0,
  the error callback received at least one `Error`, in (a) one whose message names status 500, and the
  `unhandledRejection` listener was never called
  - verify: integration
- **AC-9** Given a separate Node.js child process that creates a trace exporter and a metrics exporter
  from the otel module with `flushIntervalMs` 60000, pointed at a 127.0.0.1 URL, and then does nothing
  else When the child process runs Then it exits by itself with exit code 0 within 5000 ms
  - verify: integration
- **AC-10** Given the trace and metrics exporter factories from the otel module entrypoint When each is
  called with a valid URL and one of `flushIntervalMs`, `maxBatchSize` or `maxQueueSize` set to 0, -1,
  1.5 or NaN, and when each is called with `queueCapacity` 64 alone, and with `queueCapacity` 0 alone
  Then every call with an invalid new option throws a `RangeError` whose message names that option; the
  call with `queueCapacity` 64 returns an exporter without throwing; and the call with `queueCapacity` 0
  throws a `RangeError` whose message names `queueCapacity`
  - verify: unit

## Constraints

- `src/otel` uses Node core only (`node:` builtins and the global `fetch`); the root `package.json` gains
  no runtime `dependencies`; `src/agent` is untouched and never imports `src/otel`.
- TypeScript strict mode, no `any`; every counter is an integer that only grows, updated with integer
  math.
- No silent failures and no swallowed rejections: every failed request and every dropped item is counted
  and reaches the error callback or `process.emitWarning`; no export path produces an unhandled
  rejection, and no export failure is thrown into the caller or the collector.
- Memory is bounded: pending items never exceed `maxQueueSize`, plus the items of the one request in
  flight.
- The flush timer never keeps the process alive.
- `@pharn-dev/phargus/otel` keeps resolving through both `import` and `require` with its own types;
  `npm run build`, `npm run check:exports`, `npm run typecheck`, `npm run lint`, `npm run format:check`
  and `npm test` keep passing; every touched file is formatted with prettier.
- Tests use only local HTTP servers bound to 127.0.0.1, never the network.
- The package version is not bumped.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these unit and integration criteria, with
  per-test results; the test stage's preflight decides whether that holds.
- `queueCapacity` decision: it stays accepted and validated as before (a positive safe integer, else a
  `RangeError`) so existing callers keep compiling and running, but it is deprecated and no longer bounds
  anything; `maxQueueSize` (items) is the only bound on pending data. It is not mapped onto
  `maxQueueSize` because the units differ (batches versus items). The docs and the option's type comment
  say so.
- Defaults: `flushIntervalMs` 1000, `maxBatchSize` 512, `maxQueueSize` 2048, following the OpenTelemetry
  batch span processor's batch and queue sizes with a shorter interval, as the increment asks.
- When `maxBatchSize` is greater than `maxQueueSize`, the effective batch size is `maxQueueSize` rather
  than an error, so setting only `maxQueueSize` small never throws.
- When a request completes and at least `maxBatchSize` items are pending, the next request starts
  immediately; otherwise the next send waits for the timer, a flush or close.
- `droppedBatches` keeps its meaning from the caller's side: the number of export calls (including
  listener callbacks) at least one of whose items was dropped, whether by overflow, by an export after
  `close()`, or by `close()` timing out. `failedBatches` counts failed requests; each request is now one
  coalesced batch. `failedItems` counts the items in failed requests, including a request aborted by
  `close()`; `exportedItems` counts the items in requests answered 2xx.
- An export call made after `close()` has been called drops its items, counted in `droppedItems` and
  `droppedBatches`.
- Rate-limited drop reporting means the first drop is reported promptly and further drops are
  aggregated into a count reported at most about once per flush interval and at flush and close, so a
  burst of drops produces a handful of reports, each naming how many items were dropped.
- Items still pending when the process exits without `close()` are not delivered, because the timer is
  unref()ed; the docs say to call `close()` (or `flush()`) before exit. This is a documented limit, not a
  silent failure of a running exporter.
- `docs/LIMITS.md` does not currently describe OTel queue limits (checked this run); it is updated only
  if the PLAN finds an OTel limit there to change.
