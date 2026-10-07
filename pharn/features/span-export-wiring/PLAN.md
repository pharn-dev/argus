---
spec_id: span-export-wiring
spec_content_hash: b249ff75b583009f23599bcc4b067903286ae8d5a600d01e59e3e9ea52b47b0d
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `span-export-wiring` (ROADMAP S4, wiring slice).

Discovery (live, this run):

- `src/agent/http-tracing.ts` subscribes to `http.server.request.start` / `http.server.response.finish`, keeps an
  `inflight` WeakMap `{ traceId, startTimeMs, startNs }` per request and on finish pushes a `TraceSpan`
  `{ traceId, method, path (query stripped), statusCode, startTimeMs, durationNs }` into a module-level bounded
  drop-oldest `SpanBuffer` (`src/agent/span-buffer.ts`, default 1024). `enable()` / `disable()` / `drainSpans()` are
  exported from `src/agent/index.ts`. Nothing calls them outside tests.
- `src/agent/auto-start.ts` (`startAgentOnce`, run by `src/agent/auto.ts`, the `argus/agent` entry) loads config,
  returns early on `!enabled || output === 'none'`, opens the output, creates the NDJSON exporter (bounded queue,
  `pipeline()`) and a sampler controller whose tick calls `exporter.export(sample)`. The tick timer is `unref()`ed.
  Sample lines are plain `AgentSample` objects with no `type` field.
- `src/agent/trace-id.ts` has `newTraceId()` and `parseTraceparent()`; there is no span-id generator.
- `src/collector/collector.ts` `consume(source)` runs `pipeline(source, aggregator, recordWindows, persistWindows,
  alertEvaluator, final stage)`. The aggregator treats every chunk as an `AgentSample` and fails on a missing numeric
  `timestamp`, so a span record reaching it would fail the pipeline. `src/collector/collector-subscribers.ts` fans out
  `window` / `alert` to `CollectorListener`s, reporting listener throws via `process.emitWarning`.
- `src/dashboard/server.ts` `handleSse` snapshots `windows` and `alerts`, subscribes `window` / `alert`, then replays
  the snapshots, all in one synchronous block; token check runs before routing (401). `src/dashboard/sse-format.ts`
  `formatEvent(event: 'window' | 'alert', payload)`.
- Existing span consumers: only `src/agent/trace-context.ac3.integration.test.ts`, which asserts individual fields
  (no whole-object equality), so adding fields to `TraceSpan` keeps it valid. Existing agent-entry tests run apps with
  no HTTP server, so no span lines appear in their output.

Design (Node core only in `src/agent`; collector and dashboard depend on the agent, never the reverse):

1. **Span id** (`src/agent/trace-id.ts`) — add `newSpanId(): string`: `randomBytes(8).toString('hex')`, re-drawn
   while all zeros (W3C parent-id shape, 16 lowercase hex). Never taken from an incoming `traceparent`.
2. **Span shape** (`src/agent/span-buffer.ts`) — `TraceSpan` gains `spanId: string` and `name: string`. The buffer
   logic is unchanged.
3. **Tracer** (`src/agent/http-tracing.ts`) — `Inflight` gains `spanId` (drawn with `newSpanId()` in `onStart`);
   `onFinish` builds `method` and `path` as today and sets `name: \`${method} ${path}\``. No other behaviour change.
4. **Span record** (`src/agent/span-record.ts`, new) — the wire shape of a span line, nothing else:
   - `SPAN_RECORD_TYPE = 'span'`; `SpanRecord = { type: 'span' } & TraceSpan` (fields: `type`, `traceId`, `spanId`,
     `name`, `method`, `path`, `statusCode`, `startTimeMs`, `durationNs`).
   - `toSpanRecord(span: TraceSpan): SpanRecord` — `{ type: 'span', ...span }` with `type` first.
   - `isSpanRecord(value: unknown): value is SpanRecord` — `typeof value === 'object' && value !== null &&
     value.type === 'span'` (the discriminator the SPEC fixes; samples carry no `type`).
5. **Span hand-off** (`src/agent/span-export.ts`, new) — moves finished spans from the tracer's buffer to the
   NDJSON exporter:
   - `createSpanExport(drain: () => SpanDrain, emit: (record: SpanRecord) => void)` →
     `{ flush(): void; readonly dropped: number }`. `flush()` calls `drain()` once, emits `toSpanRecord(span)` for
     each span oldest first, and adds the drain's `dropped` to an integer running total (`dropped`), so buffer
     overflow is counted, never silent. It holds no queue of its own: the tracer's span buffer (bounded, 1024) and the
     exporter's queue (`queueBound`) are the only buffers, both drop-oldest.
6. **Agent entry wiring** (`src/agent/auto-start.ts`) — after the existing early return (so a disabled agent or
   `output: none` exports and traces nothing, as today):
   - call the tracer's `enable()` (default span buffer size; no new config option);
   - `const spans = createSpanExport(drainSpans, (record) => exporter.export(record))`;
   - the sampler controller's callback becomes: `exporter.export(sample); spans.flush();` — so every span reaches the
     output no later than the next sampling tick, after that tick's sample line;
   - a shutdown flush: `process.once('beforeExit', onBeforeExit)` where `onBeforeExit` calls `spans.flush()` once.
     `once` guarantees a single flush, so the write it schedules cannot re-trigger `beforeExit` forever, and spans
     finished after the last tick still reach the file;
   - the existing `disable(err)` path also calls the tracer's `disable()` and removes the `beforeExit` listener
     (`process.off`), then reports as today. A throw from `spans.flush()` inside the tick or `beforeExit` is caught and
     routed to that same `disable(err)` (one `[argus]` stderr line), never into the monitored process.
   - Import the tracer functions under aliases (`enable as enableTracing`, `disable as disableTracing`) to avoid the
     local `disable` name.
7. **Agent entrypoint** (`src/agent/index.ts`) — export `toSpanRecord`, `isSpanRecord`, `SPAN_RECORD_TYPE`,
   `createSpanExport` and the types `SpanRecord`, `SpanExport`; every existing export is kept.
8. **Collector span routing** (`src/collector/span-router.ts`, new) — `createSpanRouter(onSpan: (span: SpanRecord)
   => void): Transform` (object mode): a chunk for which `isSpanRecord(chunk)` holds is handed to `onSpan` and not
   forwarded; every other chunk is forwarded unchanged. An `onSpan` throw fails the transform via `callback(error)`
   (explicit, never swallowed). Imports `isSpanRecord` / `SpanRecord` from `../agent/index.js`.
9. **Collector subscribers** (`src/collector/collector-subscribers.ts`) — `CollectorListener` gains
   `span?(span: SpanRecord): void`; `SubscriberSet` gains `emitSpan(span)` with the same try/catch +
   `process.emitWarning` reporting as `emitWindow` / `emitAlert`.
10. **Collector** (`src/collector/collector.ts`):
    - `CollectorOptions` gains `spanCapacity?: number` (default `DEFAULT_SPAN_CAPACITY = 1024`); it is validated
      eagerly by `createRingBuffer` (positive safe integer, else `RangeError`).
    - `Collector` gains `readonly spans: RingBuffer<SpanRecord>`.
    - `consume(source: Readable | AsyncIterable<AgentSample | SpanRecord>)`: `pipeline(source,
      createSpanRouter((span) => { spans.push(span); subscribers.emitSpan(span); }), aggregator, …)` — the rest of the
      pipeline is unchanged. Spans never reach the aggregator or the alert evaluator, so windows and alerts are
      identical to a run over the same samples with no spans.
11. **Collector entrypoint** (`src/collector/index.ts`) — export `createSpanRouter` and `DEFAULT_SPAN_CAPACITY`;
    re-export `type SpanRecord` from the agent for consumers. Every existing export is kept.
12. **SSE format** (`src/dashboard/sse-format.ts`) — the event union becomes `'window' | 'alert' | 'span'`.
13. **Dashboard server** (`src/dashboard/server.ts`) — in the same synchronous snapshot-and-subscribe block: take
    `collector.spans.snapshot()`, add `span: (s) => client.send(formatEvent('span', s))` to the subscription, and
    replay the span snapshot after the window and alert snapshots (oldest first), mirroring windows and alerts. The
    token check is untouched and still runs before routing, so an unauthorized request gets 401 and never subscribes.
    Each client's existing bounded queue (`maxBufferedEvents`, drop-oldest) bounds span events too.

Constraints held by construction: `src/agent` gains only `node:crypto` (already used) and its own files;
`node:async_hooks` stays in `context.ts`; span timing stays integer (`Date.now()`, `hrtime.bigint()` difference
clamped to a safe integer); every buffer is fixed-capacity drop-oldest; no `.pipe()`; sample lines keep their exact
shape.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there are no
  lessons to apply.

## Steps

- Add `newSpanId()` to `src/agent/trace-id.ts`; add `spanId` and `name` to `TraceSpan`; set them in
  `src/agent/http-tracing.ts`.
- Add `src/agent/span-record.ts` and `src/agent/span-export.ts`; export them from `src/agent/index.ts`.
- Wire tracing, per-tick span flush and the one-shot `beforeExit` flush into `src/agent/auto-start.ts`.
- Add `src/collector/span-router.ts`; extend `collector-subscribers.ts` and `collector.ts` (`spanCapacity`, `spans`,
  router stage); update `src/collector/index.ts`.
- Add `'span'` to `formatEvent`; subscribe and replay spans in `src/dashboard/server.ts`.
- Run `npx prettier --write` on each written file, then `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run build` and `npm run check:exports`.

## Files

- `src/agent/trace-id.ts` — modified. Adds `newSpanId()` (16 lowercase hex, never all zeros).
- `src/agent/span-buffer.ts` — modified. `TraceSpan` gains `spanId` and `name`.
- `src/agent/http-tracing.ts` — modified. Draws a span id at request start; sets `name` to method, space, path.
- `src/agent/span-record.ts` — new. `SPAN_RECORD_TYPE`, `SpanRecord`, `toSpanRecord`, `isSpanRecord`.
- `src/agent/span-export.ts` — new. `createSpanExport(drain, emit)` with `flush()` and an integer `dropped` total.
- `src/agent/auto-start.ts` — modified. Enables HTTP tracing with the agent, flushes spans after each sample tick and
  once on `beforeExit`, tears tracing down on the disable path.
- `src/agent/index.ts` — modified. Exports the span record and span export API; keeps every existing export.
- `src/collector/span-router.ts` — new. Object-mode Transform that diverts span records to a callback.
- `src/collector/collector-subscribers.ts` — modified. `span` listener and `emitSpan`.
- `src/collector/collector.ts` — modified. `spanCapacity` option, `spans` ring, span router stage ahead of the
  aggregator.
- `src/collector/index.ts` — modified. Exports `createSpanRouter`, `DEFAULT_SPAN_CAPACITY`, `type SpanRecord`.
- `src/dashboard/sse-format.ts` — modified. `formatEvent` accepts `'span'`.
- `src/dashboard/server.ts` — modified. Subscribes to and replays spans as `span` SSE events behind the existing
  token gate.

### Explicitly not touched

- `src/agent/context.ts` — the single `node:async_hooks` importer; unchanged.
- `src/agent/ndjson-exporter.ts`, `src/agent/ndjson-encoder.ts`, `src/agent/sampler-controller.ts`,
  `src/agent/bounded-queue.ts`, `src/agent/config*.ts`, `src/agent/agent-output.ts`, `src/agent/auto.ts` — reused as
  is; no new configuration option.
- `src/collector/window-aggregator.ts`, `src/collector/window.ts`, `src/collector/alert-evaluator.ts`,
  `src/collector/ring-buffer.ts`, `src/collector/window-store.ts` — reused as is; spans never reach them.
- `src/dashboard/auth.ts`, `src/dashboard/sse-client.ts` — reused as is.
- `src/otel/**` — OTel span export is out of scope.
- Every existing `*.test.ts` — must keep passing unchanged.
- `package.json`, `vitest.config.mts`, `tsconfig*.json`, `eslint.config.mjs`, `scripts/**` — test and build
  infrastructure; no export subpath changes.

## Acceptance mapping

- **AC-1** (child process with `--import argus/agent`, `ARGUS_OUTPUT` a file, local `node:http` server, three
  requests: query string, 404, valid `traceparent`; exits after at least one interval): `auto-start` enables tracing
  because output is a file; each response finish pushes a `TraceSpan` with a fresh `spanId` and `name` `METHOD /path`
  (query stripped by the tracer); the next tick (or the one-shot `beforeExit` flush) drains them and the exporter
  writes three `{"type":"span",…}` lines; the `traceparent` request carries the parsed trace-id; sample lines are
  still written by the unchanged controller callback, with no `type` field.
- **AC-2** (`spanCapacity: 2`, a `span` subscriber, a source interleaving samples and four span records): the router
  diverts each span to `spans.push` and `emitSpan` in arrival order, so the subscriber sees all four and
  `spans.snapshot()` returns the last two; samples alone reach the aggregator, so `windows` / `alerts` equal those of
  a second collector fed only the samples.
- **AC-3** (server with a token; one client with the correct token, one with none; collector then consumes span
  records): the authorized client's subscription forwards each span as `event: span` with the record as JSON `data:`,
  in order; the tokenless request is answered 401 before routing and never subscribes, so it gets no `span` event.

## Risks & open questions

- **Shared exporter queue.** Span lines and sample lines share the exporter's drop-oldest queue (`queueBound`); a
  burst of spans larger than the queue can push out queued sample lines before they are written. Bounded by design
  (SPEC constraint); flagged for `/pharn-grill`.
- **Exit timing.** The tick timer is `unref()`ed; spans finished after the last tick rely on the one-shot `beforeExit`
  flush. A process that ends with `process.exit()` skips `beforeExit`, so spans since the last tick are lost there
  (as unflushed samples are today). AC-1's app exits naturally.
- **Tracing is now on whenever the agent exports.** `enable()` patches `http.Server.prototype.emit` and
  `https.Server.prototype.emit` in every process that loads `argus/agent` with an output, as the SPEC assumes; the
  overhead is one WeakMap entry and one span object per request.
- **Span drop count** is kept as an integer on the span export object but is not put on the wire (sample lines must
  keep their exact shape); surfacing it is left to a later slice.
- **Replay on connect.** A new SSE client is sent the spans already in the collector's ring (as for windows and
  alerts). AC-3 connects before spans arrive, so it sees only live spans.
- **Names are plan choices** (`newSpanId`, `SpanRecord`, `SPAN_RECORD_TYPE`, `toSpanRecord`, `isSpanRecord`,
  `createSpanExport`, `spanCapacity`, `DEFAULT_SPAN_CAPACITY`, `Collector.spans`, `CollectorListener.span`,
  `createSpanRouter`, SSE event `span`). The AC tests drive these.
