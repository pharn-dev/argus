---
spec_id: otel-metrics-export
state: Approved
spec_content_hash: d8534eba08d336eefefb5cc774418212ecf85c913cd566e3d2249764ff355a78
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S7 (OpenTelemetry adapter), slice 1: metrics only. Users who already run an
OpenTelemetry-compatible backend want Argus's aggregated metrics to show up there, without Argus pulling
an `@opentelemetry` dependency into their process and without the agent core changing. FEATURES.md §4
and CLAUDE.md put OTel export behind an opt-in adapter outside the agent core. This slice adds that
adapter as a new module `src/otel`, exposed as a new `argus/otel` package subpath: it converts the
collector's aggregated windows into OTLP/HTTP JSON metrics and POSTs them to a configurable endpoint,
reporting every export failure and counting every batch it has to drop.

## Scope

**In scope:**

- A converter from the collector's `AggregatedWindow` to an OTLP/HTTP JSON metrics request body
  (`resourceMetrics` → `scopeMetrics` → `metrics`): gauges for event-loop lag (max, p99, mean) and memory
  (heapUsed last and max, rss last and max), and a sum for the GC count.
- An exporter that POSTs converted batches of one or more windows to a configurable endpoint URL
  (`http:` or `https:`) with `Content-Type: application/json` and optional caller-supplied headers.
- Failure reporting: a non-2xx response, a connection error or a timeout is passed to a caller-supplied
  error callback; it is never thrown into the caller or the collector and never silently discarded.
- A bounded queue of pending batches: when it is full, a further batch is dropped and an integer
  dropped-batch counter, readable on the exporter, is incremented.
- A new `src/otel` module exported through a new `argus/otel` subpath with `import`, `require` and
  `types` conditions for both the ESM and CJS builds, with vitest tests.

**Out of scope (non-goals):**

- Trace (span) export, and OTel logs.
- OTLP over gRPC or protobuf encoding; only OTLP/HTTP with JSON encoding.
- Retries with backoff, persistence of unsent batches, or compression.
- Exporting alerts, backpressure metrics or per-kind GC breakdowns.
- Any `@opentelemetry/*` or other third-party runtime dependency.
- Any change to `src/agent`, and any import of `src/otel` from `src/agent`.

## Acceptance Criteria

- **AC-1** Given an aggregated window with start 1700000000000, end 1700000001000, event-loop max 5000000,
  p99 4000000 and mean 2000000, heapUsedLast 1000, heapUsedMax 2000, rssLast 3000, rssMax 4000 and GC
  count 7 When it is passed to the converter imported from the otel module entrypoint Then the returned
  value is a JSON-serializable object with one `resourceMetrics` entry whose metrics include a gauge data
  point for each of the three event-loop values and the four memory values carrying exactly those
  integer values, and a sum whose single data point carries the GC count 7 with delta aggregation
  temporality and `isMonotonic` true; and every data point's `timeUnixNano` is the string
  "1700000001000000000" and every sum data point's `startTimeUnixNano` is the string
  "1700000000000000000"
  - verify: unit
- **AC-2** Given a local HTTP server listening on 127.0.0.1 that answers 200 and an exporter created from
  the otel module entrypoint with that server's URL and the header `x-api-key: test-key` When one batch
  of two aggregated windows is exported and the exporter's flush completes Then the server has received
  exactly one POST request with `content-type` `application/json` and `x-api-key` `test-key` whose body
  parses as JSON containing the metric data points of both windows, the exporter's dropped-batch counter
  is 0, and the error callback was never called
  - verify: integration
- **AC-3** Given an exporter created from the otel module entrypoint with a queue capacity of 1 and an
  error callback When (a) it exports to a local 127.0.0.1 server that answers 500, (b) it exports to a
  127.0.0.1 port with no listener, and (c) it is handed three batches while a server on 127.0.0.1 holds
  the first request open Then in (a) and (b) the export and flush calls neither throw nor reject and the
  error callback receives one `Error` per failed batch, in (a) naming status 500; and in (c), after the
  held request is released and flush completes, the server has received exactly two requests and the
  dropped-batch counter is the integer 1
  - verify: integration

## Constraints

- Only Node core is used (`node:http`, `node:https`, global `fetch` and other `node:` builtins); the root
  `package.json` gains no runtime `dependencies`.
- `src/agent` never imports from `src/otel`; `src/otel` may import types and values from `src/collector`
  and `src/agent`.
- `argus/otel` resolves through both `import` and `require` with its own types; `npm run build`,
  `npm run check:exports`, `npm run typecheck`, `npm run lint` and `npm run format:check` keep passing.
- Request bodies follow the OTLP/HTTP JSON encoding: 64-bit integer fields (`timeUnixNano`,
  `startTimeUnixNano`, `asInt`) are decimal strings, and nanosecond timestamps are computed exactly from
  millisecond integers (no float rounding).
- No export failure is thrown into the caller or the collector, and none is swallowed: each one reaches
  the error callback. The dropped-batch counter is an integer.
- The exporter's memory is bounded by its queue capacity regardless of how many batches are handed to it.
- Tests use only local HTTP servers bound to 127.0.0.1, never the network. Node 22 or later, TypeScript
  strict mode.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these unit and integration criteria, with
  per-test results; the test stage's preflight decides whether that holds.
- Lag values are in nanoseconds (unit `ns`) and memory values in bytes (unit `By`), as the collector's
  `AggregatedWindow` documents; values are emitted as integer data points (`asInt`) unchanged.
- A gauge data point's `timeUnixNano` is the window end; the GC sum uses delta temporality with the window
  start as `startTimeUnixNano` and the window end as `timeUnixNano`, since each window's GC count covers
  only that window.
- At most one request is in flight at a time; the queue holds batches waiting behind it, and a batch that
  arrives when the queue is full is the one dropped (drop-newest).
- A dropped batch is counted, not reported through the error callback; only failed exports call it.
- "Batch" means one export call's group of one or more windows, sent as one request.
- The exporter exposes a flush (or equivalent) whose completion means every queued batch has been sent
  or reported as failed; it resolves, never rejects, for export failures.
- A request timeout exists with a default chosen by the PLAN, and a timeout is reported like any other
  failure.
- The resource carries a `service.name` attribute with a default chosen by the PLAN, overridable by the
  caller.
- Exact exported names, metric names, option names, whether `node:http`/`node:https` or `fetch` sends
  the request, and how the exporter is wired to a collector (for example through the collector's
  subscribe listener) are left to the PLAN.
- The `argus/otel` subpath criterion is checked by `npm run check:exports` at verify rather than by an
  acceptance test, since it needs a build first.
