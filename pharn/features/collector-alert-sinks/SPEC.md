---
spec_id: collector-alert-sinks
state: Approved
spec_content_hash: c6e745deefa7ef7adeb513f36a09c5df48210af2238c02ae670502fb85c83899
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S2 (collector pipeline), slice 3: alert sinks (FEATURES.md §8, "Alert sinks: stdout / file /
webhook. Webhook uses Node core http/fetch only"). The collector already evaluates per-metric alert rules
over aggregated windows and keeps the emitted `firing` / `resolved` alerts in a ring buffer, but nothing
delivers them anywhere. A user diagnosing a live process needs those alerts written to the console, to a
file they can tail, or posted to an HTTP endpoint they already watch, without adding any third-party
dependency and without a slow or broken destination being able to stall or crash the monitored pipeline.
This slice adds three sinks behind one small interface and lets `createCollector` deliver every alert to
every configured sink. Disk persistence of windows is the next slice.

## Scope

**In scope:**

- One small sink interface (for example `send(alert): Promise<void>` and `close(): Promise<void>`) with
  per-sink integer counters for failed and dropped deliveries.
- A stdout sink: one NDJSON line per alert written to a given Writable (default `process.stdout`),
  honouring `write()` backpressure, and never ending that stream.
- A file sink: an append-only NDJSON file opened in append mode, one line per alert, flushed and closed on
  `close()`.
- A webhook sink: each alert POSTed as JSON (`content-type: application/json`) to a configured `http:` or
  `https:` URL using Node core `fetch` or `http` only; a hard per-request timeout; a bounded number of
  retries with backoff on network errors and 5xx responses; a non-2xx outcome after retries counted and
  reported, never thrown into the pipeline and never an unhandled rejection; a bounded in-flight queue
  whose overflow is dropped and counted in an integer counter.
- Sink configuration validated at construction: an unknown sink type, a URL whose scheme is not `http:` or
  `https:`, or a non-positive timeout, a negative or non-integer retry count, or a non-positive queue bound
  is rejected with an error naming the sink.
- `createCollector` gains an optional `sinks` option: every alert the evaluator emits is delivered to every
  configured sink; a failing sink never stops the pipeline or the other sinks, its failures are counted and
  exposed per sink, and each failure is surfaced through an error callback.
- Everything exported from `src/collector/index.ts`, with vitest tests; the webhook sink is tested against
  a local `node:http` server.

**Out of scope (non-goals):**

- Disk persistence of aggregated windows or snapshots (the next slice).
- SSE delivery to the dashboard, OTel export, or any sink beyond stdout, file and webhook.
- Webhook authentication schemes, custom headers, request signing, batching several alerts into one
  request, or TLS configuration beyond what Node core `fetch` / `https` does by default.
- File rotation, size limits on the file sink, or replaying undelivered alerts after a restart.
- Any change to `src/agent`, the window aggregator, or the alert evaluator's output.

## Acceptance Criteria

- **AC-1** Given a stdout sink created from the collector entrypoint over an in-memory Writable, and a file
  sink created from the collector entrypoint over a path inside a temporary directory whose file already
  contains one line When two alerts, one `firing` and one `resolved`, are sent to each sink and each sink
  is closed Then the Writable has received exactly two lines that each parse as JSON equal to the sent
  alerts in order and the Writable has not been ended, and the file holds its original line followed by
  exactly two lines that each parse as JSON equal to the sent alerts in order
  - verify: integration
- **AC-2** Given a webhook sink created from the collector entrypoint pointing at a local `node:http`
  server When one alert is sent to a server that answers 200, to a server that answers 500 to the first
  request and 200 to the second with at least one retry configured, and to a server that never answers
  within the configured timeout with zero retries Then the first two sends resolve with the server having
  received a POST whose `content-type` is `application/json` and whose body parses as JSON equal to the
  alert (two POSTs in the retry case), the timeout send resolves without throwing within a bounded time,
  and the sink's failed counter reads 0, 0 and 1 respectively; and given a webhook sink with an in-flight
  queue bound of 1 to a server that never answers When three alerts are sent without awaiting Then its
  dropped counter reads 2
  - verify: integration
- **AC-3** Given a collector created from the collector entrypoint with `windowMs` 1000, capacity 10, one
  alert rule on `eventLoop.max` with `>` 100, an error callback, and two sinks, a stdout sink over an
  in-memory Writable and a webhook sink pointing at a local `node:http` server that answers 500 to every
  request with zero retries When it consumes a readable source of agent samples spanning three consecutive
  windows whose event-loop max values are 50, 500 and 50, and the source ends Then its completion
  resolves, the Writable has received two NDJSON lines (one `firing`, one `resolved`), the webhook sink's
  failed counter reads 2, and the error callback has been called; and when a collector is created with a
  sink of unknown type, or a webhook sink whose URL scheme is `ftp:`, or a webhook timeout of 0 Then
  creation throws synchronously with a message that names the offending sink
  - verify: integration

## Constraints

- `src/collector` uses Node core modules only (no third-party dependencies, no third-party HTTP client);
  `src/agent` never imports from `src/collector`.
- Stream composition uses `stream/promises` `pipeline()`, never `.pipe()`; every stream, request and file
  error is surfaced explicitly (counted and reported), never swallowed and never an unhandled rejection.
- Failure, drop and retry counters are integers.
- A collector created without `sinks` keeps its existing behaviour (the collector-windows and
  collector-alerts criteria still hold).
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build must keep
  compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these criteria, with per-test results
  already configured; the test stage's preflight decides whether that holds.
- Sinks may be passed to `createCollector` either as sink instances or as configuration objects with a
  `type` of `stdout`, `file` or `webhook`; "an error naming the sink" means the message contains the sink's
  type, and its configured name or index when one is given. The PLAN picks the exact shape and exported
  names.
- A sink's `send()` never rejects for a delivery failure: failures are counted and reported through the
  sink's error callback (or the collector's), so a caller awaiting `send()` cannot observe an unhandled
  rejection.
- The webhook sink's default timeout, retry count, backoff and queue bound are small, finite values chosen
  by the PLAN; backoff in tests may be configured short so tests stay fast.
- A 4xx response is not retried; it counts as one failure. Network errors, timeouts and 5xx responses are
  retried up to the configured count; the failed counter increases once per alert that ultimately fails,
  not once per attempt.
- The collector delivers alerts to sinks without letting a slow sink block window aggregation: the
  pipeline's completion waits for in-flight deliveries to settle (or for the sinks' `close()`), so a test
  can observe counters after completion resolves.
- The stdout sink waits for `drain` when `write()` returns false and never calls `end()` on the stream it
  was given; closing it only stops further writes.
- The file sink creates the file if it does not exist.
