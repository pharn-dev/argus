---
spec_id: agent-trace-context
spec_content_hash: 921ee6193a3185e612ffeafa4ac8697c7d415511343bbcf3a1d71984679b351b
---

## Files

- `src/agent/trace-context.ac1.test.ts` — the tests for AC-1
- `src/agent/trace-context.ac2.integration.test.ts` — the tests for AC-2
- `src/agent/trace-context.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/agent/trace-context.ac1.test.ts` | src/agent/index.ts#currentTraceId(): string | undefined and runWithTrace<T>(fn: () => T): T — called outside any trace, then twice with an async fn that reads currentTraceId() synchronously, after an await, in a setTimeout callback, in a .then() chain and in an EventEmitter listener emitted asynchronously inside the trace; each id must match ^[0-9a-f]{32}$, be equal within a run, differ across runs, and currentTraceId() is undefined after both runs complete
- AC-2 | integration | `src/agent/trace-context.ac2.integration.test.ts` | src/agent/index.ts#enable(options?: HttpTracingOptions): void and disable(): void, with a real node:http server on 127.0.0.1 port 0 whose handler awaits a short setTimeout then responds with String(currentTraceId()); at least ten concurrent GET requests, one with header traceparent: 00-<32 hex>-<16 hex>-01 and one with an invalid traceparent; every body matches ^[0-9a-f]{32}$, all bodies distinct, the valid request returns that trace-id, the invalid request returns a fresh id different from the invalid value; disable() and server close in afterAll
- AC-3 | integration | `src/agent/trace-context.ac3.integration.test.ts` | src/agent/index.ts#enable({ spanBufferSize: number }): void, drainSpans(): SpanDrain = { spans: TraceSpan[]; dropped: number }, disable(): void; TraceSpan = { traceId: string; method: string; path: string; statusCode: number; startTimeMs: number; durationNs: number } — a real node:http server on 127.0.0.1 port 0 responding with currentTraceId() (404 for one path); more sequential requests than spanBufferSize (one with a query string), then drainSpans() (waiting a few setImmediate turns until the server-side response finish is recorded), then enable() again plus one request giving exactly one span, then disable() plus one request whose handler sees undefined and adds no span
