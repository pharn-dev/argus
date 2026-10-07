---
spec_id: otel-metrics-export
spec_content_hash: d8534eba08d336eefefb5cc774418212ecf85c913cd566e3d2249764ff355a78
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `otel-metrics-export` (ROADMAP S7, slice 1:
> metrics only).

Discovery (live, this run): one npm package (`"type": "module"`), dual build by `scripts/build.mjs`, which runs
`tsc -p tsconfig.esm.json` and `tsc -p tsconfig.cjs.json`; both include `src/**/*.ts` (tests excluded), so a new
`src/otel/` directory is compiled into `dist/esm/otel/` and `dist/cjs/otel/` with no build-script change.
`scripts/check-exports.mjs` iterates every key of `package.json` `exports`, so a new `./otel` entry is smoke-tested
by `npm run check:exports` with no script change. `vitest.config.mts` includes `src/**/*.test.ts`, so tests under
`src/otel/` run with no config change. `eslint.config.mjs` restricts `src/agent/**/*.ts` (non-test) with
`no-restricted-imports`: pattern 1 `^(?!node:|\.)` (only `node:` and relative), pattern 2
`(^|/)(collector|analyzer|dashboard|plugin-runner)(/|$)` (no other module). A relative `../otel/...` import from the
agent passes pattern 1, so pattern 2 must gain `otel` for the SPEC's "src/agent never imports src/otel" to be
lint-enforced. `tsconfig.base.json` is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`,
`lib: ["ES2022"]`; global `fetch`/`AbortSignal.timeout` types come from `@types/node` (already used by
`src/collector/webhook-sink.ts`). `src/collector/window.ts` defines `AggregatedWindow` (`start`, `end` in ms;
`eventLoop.{max,p99,mean}` ns; `memory.{heapUsedLast,heapUsedMax,rssLast,rssMax}` bytes; `gc.count`; all integers),
re-exported as a type from `src/collector/index.ts`, which also exports `CollectorListener`
(`{ window?(w): void; alert?(a): void }`) and `Collector.subscribe(listener)`. Every existing module has a scaffold
`index.test.ts`; that is a module-local convention, not a requirement, and this plan adds none (the AC tests import
the entrypoint).

Design (each file one axis of change; Node core only; `src/otel` imports only `import type` from
`../collector/index.js`; nothing in `src/agent` or `src/collector` imports `src/otel`):

1. **OTLP JSON types** (`src/otel/otlp-types.ts`, new) — the subset of the OTLP/HTTP JSON metrics schema this
   module emits, types only: `OtlpAnyValue = { stringValue: string }`, `OtlpKeyValue = { key: string; value:
   OtlpAnyValue }`, `OtlpNumberDataPoint = { startTimeUnixNano?: string; timeUnixNano: string; asInt: string }`,
   `OtlpGauge = { dataPoints: OtlpNumberDataPoint[] }`, `OtlpSum = { dataPoints: OtlpNumberDataPoint[];
   aggregationTemporality: 1; isMonotonic: boolean }`, `OtlpMetric = { name; description; unit } & ({ gauge } |
   { sum })`, `OtlpMetricsRequest = { resourceMetrics: [{ resource: { attributes: OtlpKeyValue[] }; scopeMetrics:
   [{ scope: { name: string }; metrics: OtlpMetric[] }] }] }`. `AGGREGATION_TEMPORALITY_DELTA = 1` (the OTLP enum
   value, emitted as the JSON integer as the OTLP JSON encoding specifies for enums).
2. **Converter** (`src/otel/otlp-metrics.ts`, new) — pure, synchronous, no I/O.
   - `msToUnixNano(ms: number): string` — requires `Number.isSafeInteger(ms) && ms >= 0` (else `RangeError`), returns
     `(BigInt(ms) * 1_000_000n).toString()`; exact, no float. `toIntString(value: number): string` — requires a
     non-negative safe integer (else `RangeError`), returns `String(value)`.
   - `toOtlpMetrics(windows: AggregatedWindow | readonly AggregatedWindow[], options?: { serviceName?: string }):
     OtlpMetricsRequest`. One `resourceMetrics` entry; resource attribute `service.name` = `options.serviceName ??
     'argus'`; one `scopeMetrics` entry with scope name `argus`. Eight metrics, each with one data point per window
     in input order:
     - gauges, unit `ns`: `argus.event_loop.lag.max`, `argus.event_loop.lag.p99`, `argus.event_loop.lag.mean`;
     - gauges, unit `By`: `argus.memory.heap_used.last`, `argus.memory.heap_used.max`, `argus.memory.rss.last`,
       `argus.memory.rss.max`;
     - sum `argus.gc.count`, unit `{collection}`, `aggregationTemporality: 1` (delta), `isMonotonic: true`.
     Gauge points carry `timeUnixNano = msToUnixNano(window.end)` and `asInt`; sum points also carry
     `startTimeUnixNano = msToUnixNano(window.start)`. The result is plain objects, arrays and strings only, so it is
     JSON-serializable. An empty array yields metrics with empty `dataPoints` (the exporter never sends one).
3. **Transport** (`src/otel/otlp-transport.ts`, new) — one POST, never throws.
   - `postOtlpJson(target: { url: string; origin: string; headers: Record<string, string>; timeoutMs: number }, body:
     string): Promise<Error | undefined>` — `fetch(url, { method: 'POST', headers: { ...headers, 'content-type':
     'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) })`, drains the response body, resolves
     `undefined` on 2xx. A non-2xx resolves `new Error('OTLP export to <origin> failed: status <n>')`; a rejected
     fetch resolves an `Error` naming `<origin>` and the cause (`{ cause }`), and a timeout (`TimeoutError` /
     `AbortError` name) names `timed out after <timeoutMs>ms`. Only the origin is ever put in a message — never the
     path, query or headers, which may carry a credential.
4. **Exporter** (`src/otel/otlp-exporter.ts`, new) — `createOtlpMetricsExporter(options: OtlpMetricsExporterOptions):
   OtlpMetricsExporter`.
   - `OtlpMetricsExporterOptions = { url: string; headers?: Record<string, string>; serviceName?: string; timeoutMs?:
     number; queueCapacity?: number; onError?: (error: Error) => void }`. Defaults: `timeoutMs` 10000,
     `queueCapacity` 64, `serviceName` `'argus'`. Validated synchronously at creation: `url` parses and its protocol
     is `http:` or `https:` (`TypeError`); `timeoutMs` and `queueCapacity` positive safe integers (`RangeError`);
     every header value a string and `serviceName` a non-empty string (`TypeError`).
   - `OtlpMetricsExporter = { export(windows: AggregatedWindow | readonly AggregatedWindow[]): void; flush():
     Promise<void>; close(): Promise<void>; readonly droppedBatches: number; readonly failedBatches: number; readonly
     listener: CollectorListener }`.
   - State: `inFlight: boolean`, a `queue: AggregatedWindow[][]` holding at most `queueCapacity` batches (batches
     waiting behind the one in flight), integer `droppedBatches`, `failedBatches`, a `closed` flag, and the current
     `drain: Promise<void> | undefined`.
   - `export(windows)`: copies the input into a new array (one batch = one call). An empty batch is ignored. If
     `closed`, or `queue.length >= queueCapacity` while a request is in flight, the batch is **dropped**:
     `droppedBatches += 1`, not reported through `onError` (SPEC assumption). Otherwise it is queued and, if no drain
     loop runs, one starts. Never throws for a full queue or a closed exporter; never awaits.
   - Drain loop (`async`, one at a time): while the queue is non-empty, take the oldest batch, set `inFlight`, build
     the body with `JSON.stringify(toOtlpMetrics(batch, { serviceName }))` inside `try/catch` (a conversion
     `RangeError` is a failed batch), `await postOtlpJson(...)`; on an `Error` result `failedBatches += 1` and
     `report(error)`. The whole loop body is wrapped so no rejection escapes; the loop's promise always resolves.
     With capacity 1: the first batch is in flight, the second waits in the queue, the third is dropped (AC-3c).
   - `report(error)`: calls `onError` in `try/catch`; with no `onError`, or one that throws, it falls back to
     `process.emitWarning(error)` — never silent, never thrown into the caller.
   - `flush()`: resolves once the queue is empty and nothing is in flight (awaits the current drain promise, looping
     until none is running); it never rejects for an export failure.
   - `close()`: sets `closed` (later `export` calls are dropped and counted), then `flush()`. Idempotent.
   - `listener`: `{ window: (w) => exporter.export(w) }` — one batch per window, for
     `collector.subscribe(exporter.listener)`; it never throws, so it cannot disturb the collector's fan-out.
   - Memory is bounded by `queueCapacity` batches plus the one in flight, whatever the number of `export` calls.
5. **Entrypoint** (`src/otel/index.ts`, new) — exports `toOtlpMetrics`, `createOtlpMetricsExporter`, the types
   `OtlpMetricsExporter`, `OtlpMetricsExporterOptions`, `OtlpMetricsRequest`, `OtlpMetric`, `OtlpNumberDataPoint`,
   and `AGGREGATION_TEMPORALITY_DELTA`.
6. **Package subpath** (`package.json`, modified) — adds `"./otel"` to `exports`, before `"./package.json"`, in the
   same shape as the other modules: `import: { types: ./dist/esm/otel/index.d.ts, default: ./dist/esm/otel/index.js }`,
   `require: { types: ./dist/cjs/otel/index.d.ts, default: ./dist/cjs/otel/index.js }`. No dependency is added and
   no script changes.
7. **Module boundary lint** (`eslint.config.mjs`, modified) — (a) adds `otel` to the agent's second restricted
   pattern: `(^|/)(collector|analyzer|dashboard|plugin-runner|otel)(/|$)`; (b) adds a block for `src/otel/**/*.ts`
   (tests ignored) with `no-restricted-imports` pattern `^(?!node:|\.)`, message "otel code may import only node:
   builtins and this package's own files.", so a third-party import (e.g. `@opentelemetry/*`) in the adapter fails
   lint.
8. **Docs** — `ARCHITECTURE.md` "Module boundaries" gains one bullet for `src/otel` (`argus/otel`: opt-in OTLP/HTTP
   JSON metrics export, Node core only, reads collector output; the agent never imports it); `README.md` module
   table gains the `otel` / `argus/otel` row.

Constraints held by construction: Node core only (global `fetch`, `AbortSignal`, `process`), no `.pipe()`, counters
change only by `+= 1`, nanosecond strings via `BigInt`, no export failure thrown or swallowed.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there are no
  lessons to apply.

## Steps

- Add `src/otel/otlp-types.ts`, `src/otel/otlp-metrics.ts`, `src/otel/otlp-transport.ts`,
  `src/otel/otlp-exporter.ts` and `src/otel/index.ts`.
- Add the `./otel` subpath to `package.json` `exports`.
- Extend `eslint.config.mjs`: `otel` in the agent's module pattern, and a Node-core-only rule for `src/otel`.
- Add the `src/otel` bullet to `ARCHITECTURE.md` and the `argus/otel` row to `README.md`.
- Run `npx prettier --write` on each written file (one by one), then `npm run typecheck`, `npm run lint`,
  `npm test`, `npm run build`, `npm run check:exports` and `npm run format:check`.

## Files

- `src/otel/otlp-types.ts` — new. OTLP/HTTP JSON metrics request types and `AGGREGATION_TEMPORALITY_DELTA`.
- `src/otel/otlp-metrics.ts` — new. `toOtlpMetrics` converter, exact ms→ns decimal strings via `BigInt`.
- `src/otel/otlp-transport.ts` — new. `postOtlpJson`: one fetch POST with timeout, resolves an `Error` or `undefined`.
- `src/otel/otlp-exporter.ts` — new. `createOtlpMetricsExporter`: validation, bounded drop-newest queue, one request
  in flight, integer `droppedBatches`/`failedBatches`, `onError` reporting, `flush`, `close`, `listener`.
- `src/otel/index.ts` — new. The `argus/otel` public entrypoint.
- `package.json` — modified. Adds the `./otel` `exports` subpath (import/require, each with types); nothing else.
- `eslint.config.mjs` — modified. Agent may not import `otel`; `src/otel` may import only `node:` and relative paths.
- `ARCHITECTURE.md` — modified. One module-boundary bullet for `src/otel`.
- `README.md` — modified. One module-table row for `argus/otel`.

### Explicitly not touched

- `src/agent/**` — out of scope per the SPEC; the agent never imports `src/otel`.
- `src/collector/**` — reused as is (`AggregatedWindow`, `CollectorListener`, `Collector.subscribe`).
- `scripts/build.mjs`, `scripts/check-exports.mjs` — already generic over `src/` and `exports`.
- `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`, `tsconfig.json`, `vitest.config.mts` — already
  include `src/**/*.ts`.
- `CLAUDE.md`, `CONTRIBUTING.md`, `CHANGELOG.md` — no standing convention changes; the boundary is lint-enforced.

## Acceptance mapping

- **AC-1** (one window: start 1700000000000, end 1700000001000, lag 5000000/4000000/2000000, memory
  1000/2000/3000/4000, GC 7): `toOtlpMetrics` from `src/otel/index.ts` returns one `resourceMetrics` entry with seven
  gauges each holding one data point whose `asInt` is the exact decimal string of the input, and the `argus.gc.count`
  sum with one point `asInt` `"7"`, `aggregationTemporality` `1` (delta), `isMonotonic` `true`; every
  `timeUnixNano` is `msToUnixNano(1700000001000)` = `"1700000001000000000"` and the sum's `startTimeUnixNano` is
  `"1700000000000000000"`; `JSON.parse(JSON.stringify(result))` deep-equals the result.
- **AC-2** (127.0.0.1 server answering 200; exporter with its URL and `x-api-key: test-key`; one batch of two
  windows; flush): the drain loop sends exactly one POST whose headers carry the caller's `x-api-key` and the forced
  `content-type: application/json`; the body is the converter output for both windows (each metric has two data
  points); `droppedBatches` is 0 and `onError` is never called.
- **AC-3** (capacity 1, error callback): (a) a 500 response resolves an `Error` naming `status 500`, counted and
  passed to `onError`; (b) a port with no listener makes `fetch` reject, which `postOtlpJson` turns into a resolved
  `Error` passed to `onError`; `export` is synchronous and never throws and `flush` never rejects in both; (c) with
  the first request held open, batch 1 is in flight, batch 2 fills the one-slot queue, batch 3 is dropped
  (`droppedBatches` becomes `1`); after release, the drain loop sends batch 2, so the server sees exactly two
  requests.
- **`argus/otel` subpath** (Scope and Constraints): checked by `npm run build` + `npm run check:exports` at verify,
  per the SPEC's assumption.

## Risks & open questions

- **Names are plan choices** (`toOtlpMetrics`, `createOtlpMetricsExporter`, options `url`, `headers`, `serviceName`,
  `timeoutMs`, `queueCapacity`, `onError`; exporter `export`, `flush`, `close`, `droppedBatches`, `failedBatches`,
  `listener`; metric names `argus.event_loop.lag.*`, `argus.memory.heap_used.*`, `argus.memory.rss.*`,
  `argus.gc.count`). The AC tests drive exactly these.
- **AC-3(c) timing.** The test must wait until the server has received the first (held) request before handing over
  batches 2 and 3, or batch 1 may still be queued rather than in flight when they arrive. Polling the server's request
  count, or resolving a promise from its request handler, removes the race.
- **AC-3(b) duration.** A refused connection on 127.0.0.1 fails fast; the default 10000 ms timeout is not hit. Tests
  may pass a small `timeoutMs` anyway.
- **fetch keep-alive.** Node's fetch pools connections; tests should close servers with `closeAllConnections()` so
  vitest does not hang on an idle socket.
- **`package.json` is pinned test infrastructure only in its `scripts`/`jest` parts**; this plan changes only
  `exports`. `check-ac-tests.mjs` may print an advisory `NOTE —` for it.
- **No scaffold `src/otel/index.test.ts`.** Other modules carry one from the scaffold step; the AC tests cover the
  entrypoint, so none is planned. Flagged for `/pharn-grill`.
- **`eslint.config.mjs` change** adds a lint rule for the new module; it is not a test-runner config.
