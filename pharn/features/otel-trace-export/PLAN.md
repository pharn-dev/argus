---
spec_id: otel-trace-export
spec_content_hash: 39d01c6e421d3dd37f716247848d64e40fcdeaacc15f6208ad430a9aea777587
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `otel-trace-export` (ROADMAP S7, slice 2: traces).

Discovery (live, this run, at `38c31e5`):

- `src/otel/` holds `index.ts`, `otlp-types.ts` (metrics-only OTLP JSON types; `OtlpAnyValue = { stringValue }`),
  `otlp-metrics.ts` (`toOtlpMetrics`, `msToUnixNano`, `toIntString`), `otlp-transport.ts` (`postOtlpJson(target,
  body): Promise<Error | undefined>`, never throws, forces `content-type: application/json`, names only the origin in
  messages) and `otlp-exporter.ts` (`createOtlpMetricsExporter`: a private `validate(options)` that returns
  `{ target, serviceName }`, then a drop-newest queue of batches, one request in flight, integer
  `droppedBatches`/`failedBatches`, `report()` → `onError` or `process.emitWarning`, `flush`, `close`, `listener`).
- `src/collector/index.ts` re-exports `type SpanRecord` (from the agent) and `type CollectorListener`, which already
  has `span?(span: SpanRecord): void`. `createCollector({ windowMs, capacity })` → `consume(source)` routes span
  records through `createSpanRouter` and calls `subscribers.emitSpan(span)` once per record, catching listener throws.
- `SpanRecord` = `{ type: 'span'; traceId; spanId; name; method; path; statusCode; startTimeMs; durationNs }`
  (`src/agent/span-record.ts`, `src/agent/span-buffer.ts`). The agent makes ids with `randomBytes(16|8).toString('hex')`
  and lowercases inbound `traceparent` ids (`src/agent/trace-id.ts`).
- `package.json` already exports `./otel`; `eslint.config.mjs` already bars the agent from importing `otel` and bars
  `src/otel` from non-`node:`/non-relative imports. `scripts/build.mjs`, `scripts/check-exports.mjs` and
  `vitest.config.mts` are generic over `src/` — no change needed to any of them.

Design (each file one axis of change; Node core only; `src/otel` reaches the collector through `import type` from
`../collector/index.js` only; nothing in `src/agent` or `src/collector` changes):

1. **Shared exporter options** (`src/otel/otlp-exporter-options.ts`, new) — the option shape and its validation, moved
   verbatim out of `otlp-exporter.ts` so both exporters validate identically.
   - `OtlpExporterOptions = { url: string; headers?: Record<string, string>; serviceName?: string; timeoutMs?:
     number; queueCapacity?: number; onError?: (error: Error) => void }`.
   - `resolveOtlpExporterOptions(options): { target: OtlpTarget; serviceName: string; queueCapacity: number; onError:
     ((error: Error) => void) | undefined }` — same checks, same error types and messages, same defaults (timeout
     10000, queue capacity 64, service name `'argus'`) as today's `validate`.
2. **Shared batch queue** (`src/otel/otlp-batch-queue.ts`, new) — the drop-newest queue + drain loop + counters +
   reporting, moved out of `otlp-exporter.ts` and made generic over the item type.
   - `createOtlpBatchQueue<T>({ capacity: number; encode: (batch: readonly T[]) => string; target: OtlpTarget;
     onError: ((error: Error) => void) | undefined }): OtlpBatchQueue<T>`, with `OtlpBatchQueue<T> = { push(batch:
     readonly T[]): void; flush(): Promise<void>; close(): Promise<void>; readonly droppedBatches: number; readonly
     failedBatches: number }`.
   - Behaviour identical to the current metrics exporter: `push` copies the batch, ignores an empty one, drops (and
     `droppedBatches += 1`) when closed or when `queue.length >= capacity` (the in-flight batch has already been
     shifted off, so capacity 1 = one in flight + one waiting), else queues and starts the drain loop if none runs.
     The drain loop sends one batch at a time: `encode` inside `try/catch` (a throw is a failed batch), then
     `await postOtlpJson(target, body)`; an `Error` → `failedBatches += 1` and `report(error)`; the loop body is wrapped
     so no rejection escapes. `report` calls `onError` in `try/catch` and falls back to `process.emitWarning(error)`
     when there is no callback or it throws. `flush` awaits until no drain runs; `close` sets closed then flushes.
     Memory is bounded by `capacity` batches plus the one in flight.
3. **Metrics exporter** (`src/otel/otlp-exporter.ts`, modified, behaviour unchanged) — `createOtlpMetricsExporter`
   becomes `resolveOtlpExporterOptions` + `createOtlpBatchQueue<AggregatedWindow>` with `encode = (batch) =>
   JSON.stringify(toOtlpMetrics(batch, { serviceName }))`; it keeps its public types (`OtlpMetricsExporterOptions`
   becomes an alias of `OtlpExporterOptions`, same fields), its `export` (single window or array, normalised to an
   array before `push`), `flush`, `close`, the two counter getters and `listener: { window: (w) => export(w) }`. The
   existing `otel-metrics-export.ac*.test.ts` files are the regression guard for "unchanged".
4. **Trace OTLP types** (`src/otel/otlp-trace-types.ts`, new; `otlp-types.ts` is left as is) — types only:
   `OtlpTraceAnyValue = { stringValue: string } | { intValue: string }`, `OtlpTraceKeyValue = { key: string; value:
   OtlpTraceAnyValue }`, `OtlpStatus = { code: 0 | 2; message?: string }`, `OtlpSpan = { traceId: string; spanId:
   string; name: string; kind: 2; startTimeUnixNano: string; endTimeUnixNano: string; attributes:
   OtlpTraceKeyValue[]; status: OtlpStatus }`, `OtlpTracesRequest = { resourceSpans: [{ resource: { attributes:
   OtlpTraceKeyValue[] }; scopeSpans: [{ scope: { name: string }; spans: OtlpSpan[] }] }] }`, and the enum constants
   `SPAN_KIND_SERVER = 2`, `STATUS_CODE_UNSET = 0`, `STATUS_CODE_ERROR = 2` (OTLP JSON encodes enums as integers).
5. **Trace converter** (`src/otel/otlp-traces.ts`, new) — pure, synchronous, no I/O.
   - `toOtlpTraces(spans: SpanRecord | readonly SpanRecord[], options?: { serviceName?: string }):
     OtlpTracesRequest`. One `resourceSpans` entry, resource attribute `service.name` = `options.serviceName ??
     'argus'`, one `scopeSpans` entry with scope name `'argus'`, one `OtlpSpan` per record in input order.
   - Ids pass through unchanged after a check: `traceId` must match `/^[0-9a-f]{32}$/` and `spanId`
     `/^[0-9a-f]{16}$/` (anchored, fixed-length character classes — no backtracking). A record that fails throws a
     `RangeError` naming which field is malformed (never the id value itself); the exporter turns that into one failed
     batch reported through `onError`, so the rest of the stream is unaffected (the listener sends one span per batch).
   - Times, exact with `BigInt`: `startTimeMs` and `durationNs` must be non-negative safe integers (else `RangeError`);
     `start = BigInt(startTimeMs) * 1_000_000n`, `end = start + BigInt(durationNs)`, both emitted as decimal strings.
     Worked example (AC-1): `1700000000123` ms → `"1700000000123000000"`; `+ 1234567` → `"1700000000124234567"`.
   - `name` = the record's `name`; `kind` = `SPAN_KIND_SERVER`; attributes, in this order:
     `http.request.method` `{ stringValue: method }`, `url.path` `{ stringValue: path }`, `http.response.status_code`
     `{ intValue: String(statusCode) }` (`statusCode` must be a non-negative safe integer, else `RangeError`).
   - `status` = `{ code: STATUS_CODE_ERROR }` when `500 <= statusCode <= 599`, else `{ code: STATUS_CODE_UNSET }`.
   - The result is plain objects, arrays, strings and integers only — JSON-serializable.
6. **Trace exporter** (`src/otel/otlp-trace-exporter.ts`, new) — `createOtlpTraceExporter(options:
   OtlpTraceExporterOptions): OtlpTraceExporter`.
   - `OtlpTraceExporterOptions` = alias of `OtlpExporterOptions` (url, headers, serviceName, timeoutMs, queueCapacity,
     onError), validated by `resolveOtlpExporterOptions` at creation.
   - `OtlpTraceExporter = { export(spans: SpanRecord | readonly SpanRecord[]): void; flush(): Promise<void>; close():
     Promise<void>; readonly droppedBatches: number; readonly failedBatches: number; readonly listener:
     CollectorListener }`.
   - Built on `createOtlpBatchQueue<SpanRecord>` with `encode = (batch) => JSON.stringify(toOtlpTraces(batch,
     { serviceName }))`; `export` normalises a single record to a one-element array and `push`es it (one call = one
     batch = one request). `listener = { span: (span) => export(span) }` — one batch per span record, for
     `collector.subscribe(exporter.listener)`; it never throws, so it cannot disturb the collector's fan-out.
7. **Entrypoint** (`src/otel/index.ts`, modified) — additionally exports `toOtlpTraces`, `createOtlpTraceExporter`,
   the types `OtlpTraceExporter`, `OtlpTraceExporterOptions`, `OtlpExporterOptions`, `OtlpTracesRequest`, `OtlpSpan`,
   and the constants `SPAN_KIND_SERVER`, `STATUS_CODE_ERROR`, `STATUS_CODE_UNSET`. Existing exports unchanged.
8. **Docs** — the `src/otel` bullet in `ARCHITECTURE.md` and the `otel` row in `README.md` say "metrics and trace
   export" instead of "metrics export".

Constraints held by construction: Node core only (global `fetch`, `AbortSignal`, `process`), no third-party import
(lint-enforced already), no `.pipe()`, counters change only by `+= 1`, nanosecond strings via `BigInt`, no export
failure thrown into the caller or collector and none swallowed, no catastrophic-backtracking regex, no file access.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there are no
  lessons to apply.

## Steps

- Add `src/otel/otlp-exporter-options.ts` and `src/otel/otlp-batch-queue.ts` by moving `validate` and the queue/drain
  logic out of `src/otel/otlp-exporter.ts`; rewrite `createOtlpMetricsExporter` on top of them with the same public
  surface. Run the existing `otel-metrics-export` tests to confirm no behaviour change.
- Add `src/otel/otlp-trace-types.ts`, `src/otel/otlp-traces.ts` and `src/otel/otlp-trace-exporter.ts`.
- Extend `src/otel/index.ts` with the trace exports.
- Update the `src/otel` bullet in `ARCHITECTURE.md` and the `otel` row in `README.md`.
- Run `node node_modules/prettier/bin/prettier.cjs --write` on each written file (one by one), then
  `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run check:exports`, `npm run format:check`.

## Files

- `src/otel/otlp-exporter-options.ts` — new. `OtlpExporterOptions` and `resolveOtlpExporterOptions` (validation and
  defaults moved unchanged from `otlp-exporter.ts`).
- `src/otel/otlp-batch-queue.ts` — new. `createOtlpBatchQueue<T>`: drop-newest bounded queue, one request in flight,
  integer `droppedBatches`/`failedBatches`, `onError`/`emitWarning` reporting, `flush`, `close`.
- `src/otel/otlp-exporter.ts` — modified. `createOtlpMetricsExporter` rebuilt on the two shared files; public types
  and behaviour unchanged.
- `src/otel/otlp-trace-types.ts` — new. OTLP/HTTP JSON traces request types and the span-kind/status enum constants.
- `src/otel/otlp-traces.ts` — new. `toOtlpTraces` converter: id checks, exact BigInt nanosecond times, SERVER kind,
  HTTP attributes, 5xx → ERROR status.
- `src/otel/otlp-trace-exporter.ts` — new. `createOtlpTraceExporter`: export/flush/close, counters, span `listener`.
- `src/otel/index.ts` — modified. Adds the trace exports to the `argus/otel` entrypoint.
- `ARCHITECTURE.md` — modified. The `src/otel` module-boundary bullet mentions trace export.
- `README.md` — modified. The `argus/otel` module-table row mentions trace export.

### Explicitly not touched

- `src/agent/**` — out of scope per the SPEC; the agent never imports `src/otel`.
- `src/collector/**` — reused as is (`SpanRecord`, `CollectorListener.span`, `Collector.subscribe`, `consume`).
- `src/otel/otlp-transport.ts`, `src/otel/otlp-metrics.ts`, `src/otel/otlp-types.ts` — reused unchanged.
- `src/otel/otel-metrics-export.ac1.test.ts`, `src/otel/otel-metrics-export.ac2.integration.test.ts`,
  `src/otel/otel-metrics-export.ac3.integration.test.ts` — the previous slice's tests; the regression guard.
- `package.json`, `eslint.config.mjs` — the `./otel` subpath and the otel import rules already exist.
- `scripts/build.mjs`, `scripts/check-exports.mjs`, `tsconfig*.json`, `vitest.config.mts` — already generic.
- `CLAUDE.md`, `CONTRIBUTING.md`, `CHANGELOG.md` — no standing convention changes.

## Acceptance mapping

- **AC-1** (two span records sharing trace id `0af7651916cd43dd8448eb211c80319c`, span ids `b7ad6b7169203331` /
  `00f067aa0ba902b7`, statuses 200 / 503, start 1700000000123 ms, duration 1234567 ns): `toOtlpTraces` from
  `src/otel/index.ts` returns one `resourceSpans` entry whose single `scopeSpans` entry holds the two spans in input
  order, ids passed through, `name` `"GET /users"`, `kind` 2, `startTimeUnixNano` `"1700000000123000000"`,
  `endTimeUnixNano` `"1700000000124234567"` (BigInt), attributes `http.request.method` `{ stringValue: "GET" }`,
  `url.path` `{ stringValue: "/users" }`, `http.response.status_code` `{ intValue: "200" | "503" }`; the 503 span's
  `status.code` is 2 and the 200 span's is 0. The result is plain data, so `JSON.parse(JSON.stringify(x))` equals it.
  Note for the test stage: the SPEC says "integer value equal to its status code" and the Constraints say `intValue`
  is a decimal string in OTLP JSON; the test should compare `Number(intValue)` to the status code (or the string).
- **AC-2** (127.0.0.1 server answering 200; trace exporter with `…/v1/traces` and `x-api-key: test-key`; collector
  with `exporter.listener` subscribed; collector consumes a source of two span records; flush): `consume` calls
  `emitSpan` per record → `listener.span` → one batch per span → two POSTs to `/v1/traces`, each with the forced
  `content-type: application/json` and the caller's `x-api-key`; bodies parse as `OtlpTracesRequest` and together
  carry both span ids under their trace id; `droppedBatches` 0 (default capacity 64); `onError` never called.
- **AC-3** (capacity 1, error callback): (a) 500 → `postOtlpJson` resolves an `Error` naming `status 500` → counted
  and passed to `onError`; (b) a port with no listener → fetch rejects → resolved `Error` → `onError`; `export` is
  synchronous and never throws and `flush` never rejects; (c) first request held open: batch 1 in flight, batch 2
  waits in the one-slot queue, batch 3 dropped (`droppedBatches` = 1); after release, batch 2 is sent → exactly two
  requests. Same queue as the metrics exporter, via `createOtlpBatchQueue`.
- **`argus/otel` subpath** (Scope, Constraints): unchanged `exports` entry; checked by `npm run build` +
  `npm run check:exports` at verify, per the SPEC's assumption.

## Risks & open questions

- **Refactor of the metrics exporter.** Moving its validation and queue into shared files is allowed by the SPEC only
  if behaviour does not change. Mitigation: move code verbatim (same messages, error types, defaults, ordering), keep
  the public types, and rely on the three existing `otel-metrics-export` test files plus `/pharn-regress`. If the
  grill prefers zero risk to the metrics slice, the fallback is to leave `otlp-exporter.ts` untouched and have the
  trace exporter use the two new shared files alone (duplicated logic, one file fewer in `## Files`).
- **Names are plan choices** (`toOtlpTraces`, `createOtlpTraceExporter`, the shared options, `SPAN_KIND_SERVER`,
  `STATUS_CODE_ERROR`, `STATUS_CODE_UNSET`, scope name and default service name `'argus'`). The AC tests drive these.
- **Malformed ids are rejected, not repaired.** A record whose `traceId`/`spanId` is not lowercase hex of the exact
  length makes its batch fail (one `onError` call, `failedBatches += 1`); the SPEC left this choice to the PLAN.
- **Unset status encoding.** Non-5xx spans carry `status: { code: 0 }` rather than omitting `status`; both are valid
  OTLP JSON and AC-1 only requires "not 2".
- **AC-2 request count.** With the listener's one-span-per-batch behaviour the server sees two requests; the SPEC's
  AC-2 counts span ids across requests, so the test must not assert one request.
- **AC-2 completion.** `consume` resolves after the source ends; the test should `await collector.consume(...)` and
  then `await exporter.flush()` before asserting, and `collector.close()` afterwards.
- **AC-3(c) timing / keep-alive.** As in the metrics slice: wait until the server has received the first held request
  before handing batches 2 and 3, and close servers with `closeAllConnections()` so vitest does not hang.
