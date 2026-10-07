---
spec_id: span-export-wiring
state: Approved
spec_content_hash: b249ff75b583009f23599bcc4b067903286ae8d5a600d01e59e3e9ea52b47b0d
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S4 (tracing), wiring slice. The agent already traces every incoming `node:http` request
automatically and keeps one completed span per request in a bounded in-process buffer, but nothing leaves
the process: a developer watching the dashboard cannot see a single request. This slice carries each
finished request span from the agent's NDJSON output, through the collector, to the dashboard's SSE
stream, so the S4 trace detail / waterfall view (a later slice) has live per-request data to show.

## Scope

**In scope:**

- When the agent is loaded and running with an NDJSON output, every incoming HTTP request handled under
  the agent's automatic trace produces, once its response finishes, exactly one span record on that same
  NDJSON output, alongside the existing sample records. A span record carries: a record-type marker
  identifying it as a span, the trace id, a span id, a name made of the request method and path, the
  start time in integer milliseconds since the epoch, the duration as a non-negative integer, and the
  response status code.
- The collector accepts span records arriving in the same source as samples, keeps the most recent N in a
  bounded ring, and notifies subscribers of each span as it is recorded.
- The dashboard SSE stream sends each span recorded by the collector as a `span` event to authorized
  clients only, under the existing token gating.

**Out of scope (non-goals):**

- The trace detail / waterfall UI and any dashboard rendering of spans.
- Child spans, outbound (client) request spans, and parent-span links.
- Route-template names (e.g. `/users/:id`): the agent has no router knowledge, so the name uses the
  request path.
- OTel span export, and disk persistence of spans.
- Any change to sample, window or alert records, their aggregation, or their SSE events.

## Acceptance Criteria

- **AC-1** Given a Node process that loads the agent entrypoint with its NDJSON output set to a file and
  runs a local `node:http` server When three requests are sent to it, one with a query string, one
  answered with status 404, and one carrying a valid W3C `traceparent` header, and the process then
  exits after at least one sampling interval Then the output file holds exactly three lines whose `type`
  is `"span"`, one per request, each with a 32-lowercase-hex `traceId`, a 16-lowercase-hex `spanId`
  distinct from the other two, a `name` equal to the request method, one space, and the path without the
  query string, a `statusCode` equal to the response status, an integer `startTimeMs` and a non-negative
  integer `durationNs`; the request with the `traceparent` header has that header's trace-id as its
  `traceId`; and the file also holds at least one sample line with no `type` field and the same fields
  a sample line had before this change
  - verify: integration
- **AC-2** Given a collector created with a span capacity of 2 and a subscriber listening for spans When
  the collector consumes a source that interleaves samples with four span records Then the collector's
  span ring returns exactly the last two span records in arrival order, the subscriber received all
  four span records in arrival order, and the collector's windows and alerts equal those produced by a
  second collector consuming the same samples with no span records
  - verify: unit
- **AC-3** Given a dashboard server started with a token over a collector When one client connects to
  the SSE endpoint with the correct token and another with no token, and the collector then consumes span
  records Then the authorized client receives one `span` event per span record, in order, whose data
  parses to that span record, and the client without a token receives HTTP 401 and no `span` event
  - verify: integration

## Constraints

- `src/agent` imports Node core modules only: zero third-party packages and zero imports from other
  `src/` modules; `node:async_hooks` stays imported only by `src/agent/context.ts`.
- Span timing is integer only: start time in integer milliseconds, duration in integer nanoseconds.
- Memory stays bounded everywhere: the agent's span hand-off, the collector's span ring and each SSE
  client's queue have a fixed capacity and drop rather than grow.
- Span records are NDJSON lines in the existing agent output, so a stream consumer can tell span lines
  from sample lines; existing sample lines keep their exact shape.
- Stream pipelines use `stream/promises` `pipeline()`; no silent failures or swallowed rejections.
- Node 22 or later, TypeScript strict mode, and the existing dual ESM/CJS build keep compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for the unit and integration criteria, with
  per-test results; the test stage's preflight decides whether that holds.
- The record-type marker is a top-level `type` field with value `"span"`; sample lines stay without a
  `type` field, and the collector tells the two apart by that field.
- The span name is the method, one space, and the URL path without the query string (e.g. `GET /users`),
  because the agent has no route knowledge; the existing span fields keep their meaning and `name` and
  `spanId` are added.
- The span id is a fresh random 16-lowercase-hex value per request (W3C parent-id shape); it is not
  taken from an incoming `traceparent`.
- Loading the agent entrypoint with an enabled, non-`none` output turns on automatic HTTP tracing and
  span export together with sampling, without a new configuration option; `output: none` or a disabled
  agent exports nothing, as today.
- Spans reach the NDJSON output no later than the next sampling tick (or shutdown flush); exact batching
  and the drop counting of the agent's existing span buffer are left to the PLAN.
- The collector's span capacity option name and default, and the accessor and subscriber callback names,
  are left to the PLAN; spans do not feed window aggregation or alert evaluation.
- Whether a newly connected SSE client is first sent the spans already in the ring (as it is for windows
  and alerts) is left to the PLAN; AC-3 connects clients before spans arrive.
