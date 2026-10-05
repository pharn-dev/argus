---
spec_id: agent-trace-context
state: Approved
spec_content_hash: 921ee6193a3185e612ffeafa4ac8697c7d415511343bbcf3a1d71984679b351b
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S4 (tracing), slice 1. A developer diagnosing a slow or misbehaving Node.js HTTP service
needs every incoming request to carry its own trace id, visible from anywhere in that request's async
work, without adding any instrumentation to their own code and without third-party tracing libraries.
This slice gives the agent an async trace context and automatic tracing of incoming HTTP requests to any
`node:http` server in the process, and records one completed span per request in a bounded in-memory
buffer, ready for the NDJSON exporter and the dashboard in later slices.

## Scope

**In scope:**

- A trace context API: `currentTraceId()` returns the active trace id, or `undefined` outside a trace;
  `runWithTrace(fn)` runs `fn` in a new trace context with a fresh random W3C-style trace id (32
  lowercase hex characters). The context propagates across `await`, timers, promise chains and event
  emitter callbacks started inside it.
- Automatic HTTP server tracing, switched by `enable()` / `disable()`: while enabled, every incoming
  request handled by any `node:http` server in the process runs inside its own trace context, so handler
  code calling `currentTraceId()` sees that request's id. A valid incoming W3C `traceparent` header's
  trace-id is adopted; an absent or invalid one yields a fresh id.
- One completed span record per traced request: trace id, method, URL path without query string,
  response status code, start time in integer milliseconds and duration in integer nanoseconds,
  delivered to a bounded in-memory buffer that drops the oldest record when full and counts the drops,
  readable through a drain/snapshot function.
- `disable()` stops tracing new requests and creating contexts; calling `enable()` twice is idempotent.
- All of the above exported from `src/agent/index.ts`, using Node core only, with vitest tests that use a
  real local `node:http` server.

**Out of scope (non-goals):**

- The waterfall view and any dashboard rendering of spans.
- Outbound (client) request spans and child spans within a request.
- Exporting spans over NDJSON, OTel or any other output.
- Injecting a `traceparent` header into responses or outbound requests.

## Acceptance Criteria

- **AC-1** Given the trace context API imported from the agent entrypoint When `currentTraceId()` is
  called outside any trace, and `runWithTrace(fn)` is called twice with a `fn` that reads
  `currentTraceId()` synchronously, after an `await`, inside a `setTimeout` callback, inside a `.then()`
  chain and inside an event emitter listener emitted asynchronously within the trace Then the outside
  call returns `undefined`; within one run every read returns the same id matching `^[0-9a-f]{32}$`; the
  two runs return different ids; and `currentTraceId()` returns `undefined` again after the runs complete
  - verify: unit
- **AC-2** Given HTTP tracing enabled from the agent entrypoint and a real local `node:http` server whose
  handler awaits a short delay and then responds with the value of `currentTraceId()` When at least ten
  requests are sent concurrently, one of them carrying a valid `traceparent` header
  (`00-<32 hex trace-id>-<16 hex parent-id>-01`) and one carrying an invalid `traceparent` value Then
  every response body is a 32-lowercase-hex trace id, all response bodies are distinct, the request with
  the valid header returns exactly that header's trace-id, and the request with the invalid header
  returns a freshly generated id different from the invalid value
  - verify: integration
- **AC-3** Given HTTP tracing enabled with a span buffer smaller than the number of requests to be sent
  When requests are sent sequentially to a real local `node:http` server (one with a query string, one
  answered with status 404), the buffer is read, then tracing is enabled a second time and one more
  request is sent, then tracing is disabled and one more request is sent Then each record read has the
  request's trace id, method, path without the query string, status code, an integer start time in
  milliseconds and a non-negative integer duration in nanoseconds; only the newest records up to the
  buffer size remain and the reported drop count equals the number of oldest records dropped; the
  request after the second `enable()` produces exactly one record; and after `disable()` the handler sees
  `currentTraceId()` as `undefined` and no new record is added
  - verify: integration

## Constraints

- `src/agent` imports Node core modules only: zero third-party and zero imports from other `src/`
  modules.
- `async_hooks` (`node:async_hooks`) is imported only by `src/agent/context.ts`; no other file imports
  it.
- Tracing requires no change to user handler code and no Node runtime flag.
- Span times are integers: start time in milliseconds, duration in nanoseconds.
- The span buffer is bounded; memory use does not grow with the number of requests traced.
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build must keep
  compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for both unit and integration criteria, with
  per-test results already configured; the test stage's preflight decides whether that holds.
- Automatic HTTP tracing is built on Node core's `node:diagnostics_channel` HTTP server channels
  available on the Node 22 floor; how the request handler is placed inside the request's context is left
  to the PLAN.
- A `traceparent` is valid when it matches the W3C version-00 shape with a non-all-zero trace-id; its
  trace-id is adopted lowercase. The parent-id is not recorded in this slice.
- The span buffer's default capacity, its configuration option, and whether reading it drains or
  snapshots (or both) are left to the PLAN; AC-3 needs only a way to set a small capacity and read the
  records and the drop count.
- `disable()` does not clear the span buffer; records already captured stay readable.
- Exact exported names beyond `currentTraceId`, `runWithTrace`, `enable` and `disable`, and the span
  record's field names, are left to the PLAN; the criteria only require they are reachable from the
  agent entrypoint.
- The context propagates through event emitter listeners when the emit happens inside the trace; binding
  emitters created outside a trace is not required.
