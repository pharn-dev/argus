---
spec_id: otel-trace-export
state: Approved
spec_content_hash: 39d01c6e421d3dd37f716247848d64e40fcdeaacc15f6208ad430a9aea777587
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S7 (OpenTelemetry adapter), slice 2: traces. The previous slice (`otel-metrics-export`)
sends the collector's aggregated windows to an OTLP/HTTP backend through `argus/otel`; the HTTP request
spans the agent now records and the collector now carries reach no OTel backend. Users who already run an
OpenTelemetry-compatible backend want those request spans to show up there as server spans, without
Argus pulling an `@opentelemetry` dependency into their process and without the agent core changing. This
slice adds trace export to the `argus/otel` module: it converts collector span records into OTLP/HTTP JSON
traces and POSTs them to a configurable `/v1/traces` endpoint, with the same failure reporting, bounded
queue and drop counting as the metrics exporter, and it attaches to a collector through the span callback
of `collector.subscribe`.

## Scope

**In scope:**

- A converter from the collector's span records to an OTLP/HTTP JSON traces request body
  (`resourceSpans` → `scopeSpans` → `spans`): each span carries its trace id (32 lowercase hex
  characters) and span id (16 lowercase hex characters), its name, the SERVER span kind, the attributes
  `http.request.method`, `url.path` and `http.response.status_code`, exact nanosecond start and end
  times, and an error status when its HTTP status code is 5xx.
- A trace exporter that POSTs converted batches of one or more span records to a configurable endpoint
  URL (`http:` or `https:`, for example ending in `/v1/traces`) with `Content-Type: application/json`
  and optional caller-supplied headers, reusing the existing OTLP transport.
- The same failure semantics as the metrics exporter: a non-2xx response, a connection error or a timeout
  reaches a caller-supplied error callback, is never thrown into the caller or the collector, and is
  never silently discarded; a bounded queue of pending batches drops a further batch when full and
  increments an integer dropped-batch counter readable on the exporter.
- A listener on the exporter that a caller passes to `collector.subscribe`, whose span callback hands
  each span record the collector emits to the exporter.
- Exports from the existing `argus/otel` subpath, with vitest tests.

**Out of scope (non-goals):**

- Parent/child span links, span events, span links and remote-parent propagation; the span records carry
  no parent span id today.
- Client spans, internal spans or any span kind other than SERVER.
- OTLP over gRPC or protobuf encoding; only OTLP/HTTP with JSON encoding.
- Retries with backoff, persistence of unsent batches, compression, or OTel logs.
- Any `@opentelemetry/*` or other third-party runtime dependency.
- Any change to `src/agent`, and any import of `src/otel` from `src/agent`.
- Any change to the behaviour of the existing metrics exporter.

## Acceptance Criteria

- **AC-1** Given two span records, the first with trace id "0af7651916cd43dd8448eb211c80319c", span id
  "b7ad6b7169203331", name "GET /users", method "GET", path "/users", status code 200, start time
  1700000000123 ms and duration 1234567 ns, and the second identical except span id "00f067aa0ba902b7"
  and status code 503 When both are passed to the trace converter imported from the otel module
  entrypoint Then the returned value is a JSON-serializable object with one `resourceSpans` entry whose
  `scopeSpans` hold exactly two spans, each with `traceId` "0af7651916cd43dd8448eb211c80319c", its own
  span id as `spanId`, `name` "GET /users", `kind` 2 (SERVER), `startTimeUnixNano` the string
  "1700000000123000000", `endTimeUnixNano` the string "1700000000124234567", and attributes
  `http.request.method` with string value "GET", `url.path` with string value "/users" and
  `http.response.status_code` with integer value equal to its status code; the 503 span's `status.code`
  is 2 (ERROR) and the 200 span's status code is not 2
  - verify: unit
- **AC-2** Given a local HTTP server listening on 127.0.0.1 that answers 200, a trace exporter created
  from the otel module entrypoint with that server's URL ending in `/v1/traces` and the header
  `x-api-key: test-key`, and a collector created from the collector module entrypoint with the exporter's
  listener passed to `collector.subscribe` When the collector consumes a source holding two span records
  and the exporter's flush completes Then the server has received at least one POST request, every one to
  the path `/v1/traces` with `content-type` `application/json` and `x-api-key` `test-key`, whose bodies
  parse as JSON and together contain exactly the two span ids of those records under the trace id they
  carry; the exporter's dropped-batch counter is 0; and the error callback was never called
  - verify: integration
- **AC-3** Given a trace exporter created from the otel module entrypoint with a queue capacity of 1 and
  an error callback When (a) it exports a batch to a local 127.0.0.1 server that answers 500, (b) it
  exports a batch to a 127.0.0.1 port with no listener, and (c) it is handed three batches while a server
  on 127.0.0.1 holds the first request open Then in (a) and (b) the export and flush calls neither throw
  nor reject and the error callback receives one `Error` per failed batch, in (a) naming status 500; and
  in (c), after the held request is released and flush completes, the server has received exactly two
  requests and the dropped-batch counter is the integer 1
  - verify: integration

## Constraints

- Only Node core is used (`node:` builtins and the global `fetch`); no `@opentelemetry/*` package, and
  the root `package.json` gains no runtime `dependencies`.
- `src/agent` never imports from `src/otel`; `src/otel` imports only `node:` builtins and relative paths.
- `argus/otel` keeps resolving through both `import` and `require` with its own types; `npm run build`,
  `npm run check:exports`, `npm run typecheck`, `npm run lint` and `npm run format:check` keep passing,
  and the existing metrics-export tests keep passing.
- Request bodies follow the OTLP/HTTP JSON encoding: `traceId` and `spanId` are lowercase hex strings of
  exactly 32 and 16 characters, 64-bit integer fields (`startTimeUnixNano`, `endTimeUnixNano`,
  `intValue`) are decimal strings, and nanosecond times are computed exactly with BigInt from the
  millisecond start and the nanosecond duration (no float rounding).
- No export failure is thrown into the caller or the collector, and none is swallowed: each one reaches
  the error callback. The dropped-batch counter is an integer, and the exporter's memory is bounded by its
  queue capacity regardless of how many batches are handed to it.
- Tests use only local HTTP servers bound to 127.0.0.1, never the network. No regular expression open to
  catastrophic backtracking, and no check-then-use file access. Node 22 or later, TypeScript strict mode.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these unit and integration criteria, with
  per-test results; the test stage's preflight decides whether that holds.
- The agent already produces OTLP-sized ids (`randomBytes(16)` and `randomBytes(8)` as lowercase hex, and
  inbound `traceparent` ids lowercased), so the converter passes ids through rather than re-deriving them;
  how it treats a record whose id is not of the required length (for example rejecting or skipping it and
  reporting) is left to the PLAN.
- A span's start is its millisecond `startTimeMs` scaled to nanoseconds, and its end is that start plus
  its `durationNs`, both as exact integers.
- Only a 5xx status code sets the ERROR status (code 2); a 4xx or lower status leaves the span status
  unset, following the OpenTelemetry HTTP semantic conventions for SERVER spans.
- The span `name` is the record's own `name` field, passed through unchanged.
- The trace exporter reuses the existing OTLP transport and mirrors the metrics exporter's options
  (url, headers, service name, timeout, queue capacity, error callback), flush, close, counters and
  drop-newest queue; whether the shared queue logic is factored out of the metrics exporter or written
  alongside it is left to the PLAN, provided the metrics exporter's behaviour does not change.
- "Batch" means one export call's group of one or more span records, sent as one request; the listener
  may hand each span record to the exporter as its own batch, which is why AC-2 counts span ids across
  requests rather than requests.
- The resource carries a `service.name` attribute with a default chosen by the PLAN, overridable by the
  caller, and the scope carries a name chosen by the PLAN.
- Exact exported names and option names are left to the PLAN.
- The `argus/otel` subpath criterion is checked by `npm run check:exports` at verify rather than by an
  acceptance test, since it needs a build first.
