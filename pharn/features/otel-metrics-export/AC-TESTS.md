---
spec_id: otel-metrics-export
spec_content_hash: d8534eba08d336eefefb5cc774418212ecf85c913cd566e3d2249764ff355a78
---

## Files

- `src/otel/otel-metrics-export.ac1.test.ts` — the tests for AC-1
- `src/otel/otel-metrics-export.ac2.integration.test.ts` — the tests for AC-2
- `src/otel/otel-metrics-export.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/otel/otel-metrics-export.ac1.test.ts` | src/otel/index.ts#toOtlpMetrics(windows: AggregatedWindow | readonly AggregatedWindow[], options?: { serviceName?: string }): OtlpMetricsRequest — called with one AggregatedWindow (type from src/collector/index.ts); observed: resourceMetrics length 1, scopeMetrics[0].metrics gauges `argus.event_loop.lag.max|p99|mean` and `argus.memory.heap_used.last|max`, `argus.memory.rss.last|max` each with one dataPoint whose asInt is the decimal string of the input value and timeUnixNano "1700000001000000000"; sum `argus.gc.count` with one dataPoint asInt "7", startTimeUnixNano "1700000000000000000", timeUnixNano "1700000001000000000", aggregationTemporality 1 (delta), isMonotonic true; JSON.parse(JSON.stringify(result)) deep-equals result
- AC-2 | integration | `src/otel/otel-metrics-export.ac2.integration.test.ts` | route POST / on a node:http server bound to 127.0.0.1 port 0 answering 200, driven by src/otel/index.ts#createOtlpMetricsExporter(options: { url: string; headers?: Record<string, string>; serviceName?: string; timeoutMs?: number; queueCapacity?: number; onError?: (error: Error) => void }): OtlpMetricsExporter — OtlpMetricsExporter = { export(windows: AggregatedWindow | readonly AggregatedWindow[]): void; flush(): Promise<void>; close(): Promise<void>; droppedBatches: number; failedBatches: number; listener: CollectorListener }; headers { 'x-api-key': 'test-key' }; export([w1, w2]) then await flush(); observed: exactly one POST, content-type application/json, x-api-key test-key, body JSON whose metrics carry data points for both windows, droppedBatches 0, onError never called
- AC-3 | integration | `src/otel/otel-metrics-export.ac3.integration.test.ts` | route POST / on node:http servers bound to 127.0.0.1 port 0, driven by src/otel/index.ts#createOtlpMetricsExporter(options) with queueCapacity 1 and an onError spy — (a) server answers 500: export and flush neither throw nor reject, onError receives one Error whose message contains "500"; (b) URL of a 127.0.0.1 port with no listener: export and flush neither throw nor reject, onError receives one Error; (c) server holds the first request open: after it arrives, two more export calls, then release and await flush(); observed: server received exactly two requests and droppedBatches is the integer 1
