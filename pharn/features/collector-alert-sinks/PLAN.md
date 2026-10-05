---
spec_id: collector-alert-sinks
spec_content_hash: c6e745deefa7ef7adeb513f36a09c5df48210af2238c02ae670502fb85c83899
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `collector-alert-sinks` (ROADMAP S2, slice 3).

Discovery (live, this run): single npm package (`"type": "module"`, dual ESM/CJS via `scripts/build.mjs`),
`tsconfig.base.json` strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, `lib: ["ES2022"]`
(global `fetch`, `AbortSignal.timeout` and `Response` come from `@types/node`), vitest `include: ['src/**/*.test.ts']`.
`src/collector/` holds `collector.ts` (`createCollector({ windowMs, capacity, alerts? })` →
`{ windows, alerts, consume(source) }`; `consume` runs `pipeline(source, aggregator, recordWindows, evaluator, async
sink → alerts.push)` from `node:stream/promises`), `alert-evaluator.ts` (exports `Alert`, `AlertState`),
`alert-rules.ts`, `ring-buffer.ts`, `window*.ts` and `index.ts` (re-exports). There is no sink code yet.

Design (each file one axis of change; Node core only; type-only imports of `Alert` from `alert-evaluator.ts`):

1. **Sink contract** (`src/collector/alert-sink.ts`, new) — types and one shared helper, no I/O.
   - `AlertSink = { readonly type: string; readonly name: string | undefined; readonly failed: number; readonly
     dropped: number; send(alert: Alert): Promise<void>; close(): Promise<void> }`. `failed` and `dropped` are
     integer getters (incremented by `+= 1` only).
   - `SinkErrorHandler = (error: Error, sink: AlertSink) => void`.
   - `sinkLabel(type, name, index?)` → `"<type> sink"`, plus ` "<name>"` and/or ` [<index>]` — the single place the
     "names the sink" message prefix is built.
   - `reportSinkError(handler | undefined, error, sink)`: calls the handler inside `try/catch`; when no handler is
     given, or the handler itself throws, falls back to `process.emitWarning(error)` so a failure is never silent and
     a throwing handler can never reach the pipeline.
   - Contract (documented in JSDoc): `send()` never rejects for a delivery failure; failures increment a counter and
     go through `reportSinkError`. `close()` waits for queued/in-flight deliveries to settle; `send()` after `close()`
     resolves immediately and counts as `dropped`.
2. **Stdout sink** (`src/collector/stdout-sink.ts`, new) —
   `createStdoutSink(options?: { stream?: Writable; name?: string; onError?: SinkErrorHandler }): AlertSink`, default
   `process.stdout`.
   - Writes are serialized on a promise chain (`tail = tail.then(() => writeLine(alert))`), so lines keep send order.
   - `writeLine`: `JSON.stringify(alert) + '\n'`; `const ok = stream.write(line, cb)`; awaits the write callback,
     and when `ok === false` also awaits `once(stream, 'drain')` (from `node:events`). A write error or a destroyed
     stream increments `failed` and is reported; the chain continues.
   - `close()` awaits `tail` and marks the sink closed; it **never** calls `end()` or `destroy()` on the stream.
3. **File sink** (`src/collector/file-sink.ts`, new) —
   `createFileSink(options: { path: string; name?: string; onError?: SinkErrorHandler }): AlertSink`.
   - Validates `path` is a non-empty string at construction (synchronous throw naming the sink).
   - Uses `node:fs/promises` `open(path, 'a')` (append mode, creates the file if missing), opened lazily on the first
     delivery inside the same serialized promise chain, then `handle.appendFile(JSON.stringify(alert) + '\n')` per
     alert. No `.pipe()` is used and no stream is composed. An open or append error increments `failed` and is
     reported; a failed open is retried on the next send.
   - `close()` awaits the chain, then `handle.close()` (each append is written when its `appendFile` promise
     resolves); a close error is reported and counted, never thrown.
4. **Webhook sink** (`src/collector/webhook-sink.ts`, new) — `createWebhookSink(options: { url: string; name?:
   string; timeoutMs?: number; retries?: number; backoffMs?: number; maxInFlight?: number; onError?:
   SinkErrorHandler }): AlertSink`.
   - Defaults (finite, small): `timeoutMs` 5000, `retries` 2, `backoffMs` 100, `maxInFlight` 100.
   - Construction validation (synchronous `TypeError`/`RangeError`, message starts with the `sinkLabel`): `url` parses
     with `new URL()` and its `protocol` is `http:` or `https:`; `timeoutMs` and `maxInFlight` are positive safe
     integers; `retries` and `backoffMs` are non-negative safe integers.
   - `send(alert)`: if closed or `inFlight >= maxInFlight` → `dropped += 1`, report a `RangeError` naming the sink,
     resolve. Otherwise `inFlight += 1`, track the delivery promise in a `Set`, and run `deliver()`; `finally`
     decrements `inFlight` and removes it from the set. The returned promise is the delivery promise, which resolves
     in every path (all errors are caught inside `deliver`).
   - `deliver(alert)`: up to `retries + 1` attempts. Each attempt: global `fetch(url, { method: 'POST', headers: {
     'content-type': 'application/json' }, body: JSON.stringify(alert), signal: AbortSignal.timeout(timeoutMs) })`,
     then the response body is drained (`await response.arrayBuffer()`) under the same signal so the socket is
     released. 2xx → success, return. 4xx → no retry. 5xx, network error or timeout → retry after
     `backoffMs * 2 ** attempt` via `node:timers/promises` `setTimeout`. After the final attempt fails: `failed += 1`
     (once per alert, not per attempt) and report an `Error` naming the sink, the URL's origin and the last status or
     cause.
   - `close()`: marks closed, then `await Promise.allSettled([...inFlightSet])`.
5. **Sink configuration** (`src/collector/sink-config.ts`, new) — the config union and its resolution.
   - `SinkConfig = { type: 'stdout'; name?; stream? } | { type: 'file'; name?; path } | { type: 'webhook'; name?;
     url; timeoutMs?; retries?; backoffMs?; maxInFlight? }`; `SinkInput = AlertSink | SinkConfig`.
   - `createSinks(inputs: readonly SinkInput[] | undefined, onError?: SinkErrorHandler): AlertSink[]` — non-array →
     `TypeError`. For each input at index `i`: an object with a `send` function and a `close` function is used as an
     instance; otherwise `type` is checked by membership in the closed set `{stdout, file, webhook}` (`RangeError`
     `sink [i]: unknown sink type "<type>"`), and the matching factory is called with the collector's `onError`. A
     factory error is re-thrown as the same error class with the message prefixed by `sinkLabel(type, name, i)` and
     the original as `cause`. All validation happens before any sink is returned, so creation is all-or-nothing;
     sinks already built are not opened (file and webhook do no I/O until `send`).
6. **Dispatch** (`src/collector/sink-dispatcher.ts`, new) — `createSinkDispatcher(sinks: readonly AlertSink[],
   onError?: SinkErrorHandler)` → `{ deliver(alert): void; settle(): Promise<void>; close(): Promise<void> }`.
   - `deliver` calls `sink.send(alert)` on every sink **without awaiting** (a slow sink never blocks aggregation),
     wraps each in `Promise.resolve().then(() => sink.send(alert)).catch(err => reportSinkError(onError, err,
     sink))` so even a user-supplied instance that throws or rejects is surfaced and never an unhandled rejection or a
     pipeline error, and tracks it in a pending `Set`.
   - `settle()` loops `await Promise.allSettled([...pending])` until the set is empty. `close()` = `settle()` then
     `Promise.allSettled(sinks.map(s => s.close()))`, reporting any rejection.
7. **Collector** (`src/collector/collector.ts`, modified).
   - `CollectorOptions` gains `sinks?: readonly SinkInput[]` and `onSinkError?: SinkErrorHandler`.
   - `Collector` gains `readonly sinks: readonly AlertSink[]` (the resolved instances, in input order, so counters
     are readable) and `close(): Promise<void>` (closes every sink; a no-op with none).
   - `createCollector` calls `createSinks(options.sinks ?? [], options.onSinkError)` after the existing validation,
     so a bad sink throws synchronously from creation. A dispatcher is created once per collector.
   - In `consume`, the final async stage becomes `for await (const alert of emitted) { alerts.push(alert);
     dispatcher.deliver(alert); }`; after `await pipeline(...)` it `await dispatcher.settle()`, so completion
     resolves only once in-flight deliveries settle and a test can read counters right after. If `pipeline` rejects,
     `consume` still settles pending deliveries (in a `try/finally`) and then rejects with the pipeline's error,
     unchanged. With no sinks, behaviour is identical to today.
8. **Entrypoint** (`src/collector/index.ts`, modified) — adds `createStdoutSink`, `createFileSink`,
   `createWebhookSink`, `createSinks` and the types `AlertSink`, `SinkErrorHandler`, `SinkConfig`, `SinkInput`,
   `StdoutSinkOptions`, `FileSinkOptions`, `WebhookSinkOptions`; keeps every existing export.

Constraints held by construction: Node core only (`node:stream`, `node:stream/promises`, `node:events`,
`node:fs/promises`, `node:timers/promises`, global `fetch`); `src/agent` is not touched and nothing in it imports the
collector; the only stream composition stays the existing `pipeline()`; counters are integers changed only by
`+= 1`; backoff is an integer product; every error path increments a counter and goes through `reportSinkError`.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there are no
  lessons to apply.

## Steps

- Add `src/collector/alert-sink.ts` (contract types, `sinkLabel`, `reportSinkError`).
- Add `src/collector/stdout-sink.ts`, `src/collector/file-sink.ts` and `src/collector/webhook-sink.ts`.
- Add `src/collector/sink-config.ts` (`SinkConfig`, `SinkInput`, `createSinks`) and
  `src/collector/sink-dispatcher.ts` (`createSinkDispatcher`).
- Extend `src/collector/collector.ts` with `sinks`, `onSinkError`, `collector.sinks`, `collector.close()`, dispatch in
  the final pipeline stage and the settle after `pipeline()`.
- Update `src/collector/index.ts` exports.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run check:exports`; run prettier on
  the written files.

## Files

- `src/collector/alert-sink.ts` — new. `AlertSink` / `SinkErrorHandler` types, `sinkLabel`, `reportSinkError`.
- `src/collector/stdout-sink.ts` — new. `createStdoutSink`: serialized NDJSON writes to a Writable, honours drain,
  never ends the stream.
- `src/collector/file-sink.ts` — new. `createFileSink`: append-mode NDJSON file via `fs/promises`, closed on
  `close()`.
- `src/collector/webhook-sink.ts` — new. `createWebhookSink`: JSON POST via global `fetch`, per-request timeout,
  bounded retries with backoff, bounded in-flight count, integer `failed` / `dropped` counters.
- `src/collector/sink-config.ts` — new. `SinkConfig` / `SinkInput` and `createSinks` (closed type set, construction
  validation with messages naming the sink).
- `src/collector/sink-dispatcher.ts` — new. Non-blocking fan-out of each alert to every sink, failure isolation,
  `settle()` / `close()`.
- `src/collector/collector.ts` — modified. `sinks` and `onSinkError` options, `collector.sinks`, `collector.close()`,
  dispatch from the final pipeline stage, settle before `consume` resolves.
- `src/collector/index.ts` — modified. Re-exports the sink factories, `createSinks` and the sink types.

### Explicitly not touched

- `src/agent/**` — out of scope per the SPEC.
- `src/collector/alert-evaluator.ts`, `src/collector/alert-rules.ts`, `src/collector/window.ts`,
  `src/collector/window-aggregator.ts`, `src/collector/ring-buffer.ts` — reused as is; evaluator and aggregator
  output do not change.
- `src/collector/collector-windows.ac1.test.ts`, `src/collector/collector-windows.ac2.test.ts`,
  `src/collector/collector-windows.ac3.test.ts`, `src/collector/collector-alerts.ac1.test.ts`,
  `src/collector/collector-alerts.ac2.test.ts`, `src/collector/collector-alerts.ac3.test.ts`,
  `src/collector/index.test.ts` — existing tests; they must keep passing unchanged.
- `vitest.config.mts`, `package.json`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`,
  `eslint.config.mjs`, `scripts/build.mjs` — test and build infrastructure, out of scope.

## Acceptance mapping

- **AC-1** (stdout sink over an in-memory Writable; file sink over a temp file that already has one line; one
  `firing` and one `resolved` alert sent to each, then `close()`): the stdout sink writes two serialized NDJSON lines
  in send order and `close()` only awaits the chain, so the Writable is not ended; the file sink opens the file with
  flag `'a'`, so the original line is kept and two lines are appended in order, and `close()` closes the handle.
- **AC-2** (webhook sink against a local `node:http` server): 200 → one POST with `content-type: application/json`
  and the JSON alert body, `failed` 0; 500 then 200 with `retries >= 1` → 5xx is retried after the (test-shortened)
  backoff, two POSTs, `failed` 0; never-answering server with `timeoutMs` small and `retries: 0` →
  `AbortSignal.timeout` aborts, the error is caught, `send` resolves, `failed` 1. With `maxInFlight: 1` and a
  never-answering server, three un-awaited sends → the first occupies the only slot, the next two are dropped,
  `dropped` 2.
- **AC-3** (collector `windowMs` 1000, capacity 10, rule `eventLoop.max > 100`, `onSinkError`, sinks
  `[{ type: 'stdout', stream }, { type: 'webhook', url, retries: 0 }]` against an always-500 server; three windows
  with max 50, 500, 50): the evaluator emits `firing` then `resolved`; the dispatcher delivers each to both sinks;
  `consume` settles deliveries before resolving, so the Writable holds two NDJSON lines, `collector.sinks[1].failed`
  is 2 and `onSinkError` was called. `createCollector` with `{ type: 'carrier-pigeon' }`, a webhook `ftp:` URL, or
  webhook `timeoutMs: 0` → `createSinks` throws synchronously with a message containing the sink's type and index.

## Risks & open questions

- **Names are plan choices** (`createStdoutSink`, `createFileSink`, `createWebhookSink`, `createSinks`,
  `CollectorOptions.sinks`, `CollectorOptions.onSinkError`, `Collector.sinks`, `Collector.close`, `AlertSink.failed`,
  `AlertSink.dropped`, webhook options `timeoutMs`, `retries`, `backoffMs`, `maxInFlight`). The AC tests drive
  exactly these.
- **Keep-alive sockets in tests.** Node's `fetch` keeps connections alive; tests should call
  `server.closeAllConnections()` before `server.close()` so a never-answering server does not hold the test open.
  The sink drains each response body so it does not leak sockets itself.
- **The "never answers" case** ties up an in-flight slot until the timeout fires; `close()` waits for it, so tests
  must use a short `timeoutMs`.
- **Sink ownership.** `consume` settles deliveries but does not close sinks (so `consume` can run more than once
  with a stdout sink); `collector.close()` closes them. A user who never calls `close()` leaves a file handle open
  until exit. Flagged for `/pharn-grill`.
- **Default error reporting** when no `onError` / `onSinkError` is given is `process.emitWarning`, so a failure is
  never silent; this is a plan choice the SPEC left open.
- **Error class.** Validation throws `TypeError` or `RangeError`; the SPEC only requires a synchronous throw whose
  message names the sink, so tests should assert on the message, not the class.
