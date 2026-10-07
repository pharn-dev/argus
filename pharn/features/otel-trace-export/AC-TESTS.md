---
spec_id: otel-trace-export
spec_content_hash: 39d01c6e421d3dd37f716247848d64e40fcdeaacc15f6208ad430a9aea777587
---

## Files

- `src/otel/otel-trace-export.ac1.test.ts` — the tests for AC-1
- `src/otel/otel-trace-export.ac2.integration.test.ts` — the tests for AC-2
- `src/otel/otel-trace-export.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/otel/otel-trace-export.ac1.test.ts` | src/otel/index.ts#toOtlpTraces(spans: SpanRecord | readonly SpanRecord[], options?: { serviceName?: string }): OtlpTracesRequest — called with two SpanRecord objects ({ type: 'span', traceId, spanId, name, method, path, statusCode, startTimeMs, durationNs }; type from src/collector/index.ts); observed: resourceSpans length 1, resourceSpans[0].scopeSpans[0].spans length 2, each with traceId "0af7651916cd43dd8448eb211c80319c", its own spanId, name "GET /users", kind 2, startTimeUnixNano "1700000000123000000", endTimeUnixNano "1700000000124234567", attributes http.request.method { stringValue: "GET" }, url.path { stringValue: "/users" }, http.response.status_code { intValue } whose Number() equals its status code; the 503 span's status.code is 2 and the 200 span's is not 2; JSON.parse(JSON.stringify(result)) deep-equals result
- AC-2 | integration | `src/otel/otel-trace-export.ac2.integration.test.ts` | route POST /v1/traces on a node:http server bound to 127.0.0.1 port 0 answering 200, driven by src/otel/index.ts#createOtlpTraceExporter(options: { url: string; headers?: Record<string, string>; serviceName?: string; timeoutMs?: number; queueCapacity?: number; onError?: (error: Error) => void }): OtlpTraceExporter — OtlpTraceExporter = { export(spans: SpanRecord | readonly SpanRecord[]): void; flush(): Promise<void>; close(): Promise<void>; droppedBatches: number; failedBatches: number; listener: CollectorListener }; headers { 'x-api-key': 'test-key' }; src/collector/index.ts#createCollector({ windowMs, capacity }).subscribe(exporter.listener), then await collector.consume(Readable.from([span1, span2])) and await exporter.flush(); observed: at least one POST, every one to path /v1/traces with content-type application/json and x-api-key test-key, bodies parse as JSON and together contain exactly the two span ids under their trace id, droppedBatches 0, onError never called
- AC-3 | integration | `src/otel/otel-trace-export.ac3.integration.test.ts` | route POST /v1/traces on node:http servers bound to 127.0.0.1 port 0, driven by src/otel/index.ts#createOtlpTraceExporter(options) with queueCapacity 1 and an onError spy — (a) server answers 500: export and flush neither throw nor reject, onError receives one Error whose message contains "500"; (b) URL of a 127.0.0.1 port with no listener: export and flush neither throw nor reject, onError receives one Error; (c) server holds the first request open: after it arrives, two more export calls, then release and await flush(); observed: server received exactly two requests and droppedBatches is the integer 1
