---
spec_id: agent-trace-context
spec_content_hash: 921ee6193a3185e612ffeafa4ac8697c7d415511343bbcf3a1d71984679b351b
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `agent-trace-context` (ROADMAP S4, slice 1).

Discovery (live, this run): the agent lives in `src/agent/` of a single npm package. `src/agent/index.ts`
re-exports every agent capability; `src/agent/auto.ts` (the `argus/agent` subpath target) re-exports
`index.ts` and calls `startAgentOnce()`. There is **no** `src/agent/context.ts` yet and nothing in `src/` or
`scripts/` imports `node:async_hooks`. `src/agent/bounded-queue.ts` already provides a drop-oldest ring buffer
(`createBoundedQueue(capacity)`, `push()` returns `true` when it evicted the oldest item, `shift()`, `length`).
ESLint restricts `src/agent/**` (non-test) to `node:` builtins and relative files. Live Node is `v24.13.1`; the
floor is Node 22.

Two live experiments this run (inline `node -e`, nothing written) grounded the HTTP mechanism:

1. Subscribing to the `node:diagnostics_channel` channel `http.server.request.start` and calling
   `AsyncLocalStorage#enterWith(store)` inside the subscriber puts the request handler — including work after an
   `await setTimeout` — inside that store: 12 concurrent requests over a keep-alive agent with 2 sockets gave 12
   distinct ids, no mismatch before/after the await, `getStore()` was `undefined` outside, and
   `http.server.response.finish` fired 12 times.
2. After `unsubscribe`, further requests on the **same** keep-alive socket saw `getStore()` as `undefined` — the
   context does not leak into later requests once the subscriber is gone.

Design, in four small files (one axis of change each):

1. **Async context** (`src/agent/context.ts`, new — the only file that imports `node:async_hooks`):
   - One module-level `AsyncLocalStorage<TraceStore>` where `TraceStore = { readonly traceId: string }`.
   - `currentTraceId(): string | undefined` → `storage.getStore()?.traceId`.
   - `runWithTrace<T>(fn: () => T): T` → `storage.run({ traceId: newTraceId() }, fn)`. Independent of
     `enable()` / `disable()` (AC-1 calls it with HTTP tracing never enabled).
   - `enterTrace(traceId: string): void` (internal, not re-exported from `index.ts`) →
     `storage.enterWith({ traceId })`; used only by the HTTP tracer so that file never touches `async_hooks`.
   - Propagation across `await`, timers, `.then()` and emitter listeners emitted asynchronously inside the trace
     is ALS's own behavior; nothing extra is bound.
2. **Trace ids** (`src/agent/trace-id.ts`, new):
   - `newTraceId(): string` → `randomBytes(16).toString('hex')` from `node:crypto` (32 lowercase hex). Regenerate
     in the astronomically unlikely all-zero case so a generated id is always W3C-valid.
   - `parseTraceparent(value: string | string[] | undefined): string | undefined` → accepts only a single string
     matching `/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i` whose trace-id is not all zeros; returns the
     trace-id lowercased, else `undefined` (an array/duplicate header is treated as invalid). Parent-id is not
     recorded (SPEC assumption).
3. **Span buffer** (`src/agent/span-buffer.ts`, new):
   - `TraceSpan = { traceId: string; method: string; path: string; statusCode: number; startTimeMs: number; durationNs: number }`.
   - `createSpanBuffer(capacity: number): SpanBuffer` wrapping `createBoundedQueue<TraceSpan>(capacity)`;
     `push(span)` increments an integer `dropped` counter when the queue reports an eviction;
     `drain(): SpanDrain` returns `{ spans: TraceSpan[]; dropped: number }` (oldest first) and resets both the
     queue and `dropped` to empty/0, so `dropped` counts the records lost since the previous drain. Memory is
     bounded by `capacity`.
4. **HTTP tracing** (`src/agent/http-tracing.ts`, new — imports `node:diagnostics_channel`, `./context.js`,
   `./trace-id.js`, `./span-buffer.js`):
   - Module state: `enabled = false`, a `SpanBuffer` (default capacity `DEFAULT_SPAN_BUFFER_SIZE = 1024`), and a
     `WeakMap<object, { traceId; startTimeMs; startNs: bigint }>` keyed by the request object.
   - `enable(options?: HttpTracingOptions): void`, `HttpTracingOptions = { spanBufferSize?: number }`. When
     already enabled → no-op (idempotent; options ignored). Otherwise: if `spanBufferSize` is given and differs
     from the current buffer's capacity, replace the buffer (validated by `createBoundedQueue`'s `RangeError`);
     then `subscribe('http.server.request.start', onStart)` and
     `subscribe('http.server.response.finish', onFinish)`; `enabled = true`.
   - `onStart({ request })`: `traceId = parseTraceparent(request.headers.traceparent) ?? newTraceId()`; record
     `{ traceId, startTimeMs: Date.now(), startNs: process.hrtime.bigint() }` in the WeakMap; `enterTrace(traceId)`.
     The channel message is typed by narrowing from `unknown` (no `any`).
   - `onFinish({ request, response })`: look up and delete the WeakMap entry (missing → return, e.g. a request that
     started before `enable()`); push one `TraceSpan`: `method = request.method ?? ''`, `path` = `request.url` up to
     the first `?` (`''` when absent), `statusCode = response.statusCode`,
     `durationNs = Number(process.hrtime.bigint() - startNs)` clamped to `[0, Number.MAX_SAFE_INTEGER]`. All
     integer; no float.
   - Each subscriber body is wrapped in `try/catch`; a caught error is reported through `process.emitWarning`
     (named `ArgusTracingWarning`) so a tracer bug never throws into the user's server and is never silent.
   - `disable(): void` → when enabled, `unsubscribe` both handlers and set `enabled = false`; a no-op otherwise.
     It does **not** clear the span buffer (SPEC assumption). After `disable()` no new context is entered for HTTP
     requests (experiment 2), so a handler sees `currentTraceId()` as `undefined`, and `onFinish` is no longer
     called, so no new record is added.
   - `drainSpans(): SpanDrain` → `buffer.drain()`.
5. **Exports** (`src/agent/index.ts`, edited): add `currentTraceId`, `runWithTrace` from `./context.js`;
   `enable`, `disable`, `drainSpans`, `DEFAULT_SPAN_BUFFER_SIZE` and type `HttpTracingOptions` from
   `./http-tracing.js`; types `TraceSpan`, `SpanDrain` from `./span-buffer.js`. `enterTrace` is not exported.
   `auto.ts` re-exports `index.ts`, so the names are reachable from `argus/agent` without editing it; auto-start
   does not enable HTTP tracing in this slice (SPEC scope names only `enable()`).

## Applied lessons

- none — `node pharn/floor/check-lessons-index.mjs . --verdict` printed `NO_CANON`: this project has no
  `memory-bank/lessons-learned.md` yet, so there are no promoted lessons to apply.

## Steps

- Create `src/agent/trace-id.ts` with `newTraceId()` and `parseTraceparent()`.
- Create `src/agent/context.ts` with the ALS store, `currentTraceId()`, `runWithTrace()` and internal
  `enterTrace()`; add a header comment that this is the single `async_hooks` importer (ARCHITECTURE.md).
- Create `src/agent/span-buffer.ts` on top of `createBoundedQueue`.
- Create `src/agent/http-tracing.ts` with `enable` / `disable` / `drainSpans` and the two channel subscribers.
- Add the exports to `src/agent/index.ts`.
- Run `npx prettier --write` on every created/edited file, then `npm run typecheck`, `npm run lint`,
  `npm test`, `npm run build`, `npm run check:exports`.

## Files

- `src/agent/context.ts` — new: AsyncLocalStorage trace context; `currentTraceId`, `runWithTrace`, internal `enterTrace`
- `src/agent/trace-id.ts` — new: random W3C trace-id generation and `traceparent` parsing
- `src/agent/span-buffer.ts` — new: bounded drop-oldest span buffer with drop counter and `drain()`
- `src/agent/http-tracing.ts` — new: `enable` / `disable` / `drainSpans` over `node:diagnostics_channel` HTTP server channels
- `src/agent/index.ts` — edit: re-export the trace context and HTTP tracing API and types

### Explicitly not touched

- `src/agent/bounded-queue.ts` — reused as-is by the span buffer
- `src/agent/auto.ts` — already re-exports `index.ts`; unchanged
- `src/agent/auto-start.ts` — auto-start does not enable tracing in this slice
- `eslint.config.mjs` — the existing agent import restriction already covers the new files
- `package.json` — no dependency or export-map change needed

## Acceptance mapping

- AC-1 → `context.ts`: `runWithTrace` uses `storage.run` with a fresh `newTraceId()` per call, so reads inside
  one run (sync, after `await`, in `setTimeout`, in `.then()`, in an emitter listener emitted asynchronously) see
  one 32-hex id, two runs differ, and outside any run `getStore()` is `undefined`.
- AC-2 → `http-tracing.ts` `onStart` enters a fresh context per request via `enterTrace` (experiment 1: distinct
  ids for concurrent requests, stable across `await`); `parseTraceparent` adopts a valid header's trace-id
  lowercased and rejects an invalid one, which then gets `newTraceId()`.
- AC-3 → `onFinish` pushes one `TraceSpan` with path stripped of its query, the real `statusCode` (404 included),
  integer `startTimeMs` (`Date.now()`) and integer non-negative `durationNs` (hrtime bigint difference);
  `enable({ spanBufferSize })` sets a small capacity, `drainSpans()` returns the newest records and the drop count;
  a second `enable()` is a no-op so one request gives exactly one record; `disable()` unsubscribes, so the handler
  sees `undefined` and no record is added.

## Risks & open questions

- `enterWith` (not `run`) is used because `diagnostics_channel` gives a hook point, not a wrapper around the
  `'request'` emit. It was verified live on Node 24 only; the channels `http.server.request.start` and
  `http.server.response.finish` exist on the Node 22 floor, but the CI matrix should confirm the same behavior on 22.
- `http.server.response.finish` is published when the server response finishes; a client may observe the response
  body before the record is pushed. AC-3's test should wait (e.g. poll `drainSpans` across a few `setImmediate`
  turns, or read after the server-side `'finish'`) rather than assume ordering — flagged for `/pharn-test`.
- A request that started before `enable()` or is still in flight at `disable()` produces no record (subscribers
  are removed together). Acceptable for this slice; not covered by an AC.
- The exported names `enable` / `disable` are generic at the `argus/agent` top level; they are what the SPEC
  names. A later slice may want a namespaced alias.
- Overhead is not benchmarked in this slice (no AC); one WeakMap entry and one `enterWith` per request.
