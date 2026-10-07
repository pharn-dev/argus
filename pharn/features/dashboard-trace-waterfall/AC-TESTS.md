---
spec_id: dashboard-trace-waterfall
spec_content_hash: "4c3d8ea4310c324116ae32048f7c6a110cba5ee9fe058ef8fcebd0e9967a1891"
---

## Files

- `src/dashboard/dashboard-trace-waterfall.ac1.test.ts` — the tests for AC-1
- `src/dashboard/dashboard-trace-waterfall.ac2.test.ts` — the tests for AC-2
- `src/dashboard/dashboard-trace-waterfall.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | unit | `src/dashboard/dashboard-trace-waterfall.ac1.test.ts` | src/dashboard/ui/waterfall-model.ts#buildWaterfall(spans: readonly unknown[], maxTraces: number): WaterfallModel — called with span records `{ type: 'span', traceId, spanId, name, method, path, statusCode, startTimeMs, durationNs }` from two traces (one span status 503, one status 200, plus a second span sharing a trace id), maxTraces large enough to keep both; observed: `model.traces[]` grouped by `traceId` with one entry in `rows[]` per span, each row's `offsetPct` equal to `(startTimeMs - earliestStart) / (latestEnd - earliestStart) * 100` and `widthPct` equal to `(durationNs / 1e6) / (latestEnd - earliestStart) * 100` (latestEnd = max of startTimeMs + durationNs / 1e6, compared with toBeCloseTo), each row's `label` containing its method, path, status code and duration in ms, `isError` true on the 503 row and false on the 200 row
- AC-2 | unit | `src/dashboard/dashboard-trace-waterfall.ac2.test.ts` | src/dashboard/ui/waterfall-model.ts#buildWaterfall(spans: readonly unknown[], maxTraces: number): WaterfallModel — called with spans from more than N distinct traces in increasing startTimeMs order and maxTraces = N; observed: the set of `model.traces[].traceId` equals exactly the N most recently started trace ids and contains none of the older ones
- AC-3 | integration | `src/dashboard/dashboard-trace-waterfall.ac3.integration.test.ts` | routes GET /?token=s3cret and GET of the page's referenced `<script src>` and `<link rel="stylesheet" href>` URLs on src/dashboard/index.ts#createDashboardServer({ collector, host: '127.0.0.1', port: 0, token: 's3cret' }): Promise<DashboardServer> (imported inside the test body) over src/collector/index.ts#createCollector({ windowMs, capacity }); observed: page status 200, an element whose aria-label or heading text contains `waterfall` or `Recent requests` (case-insensitive), no inline `<script>` content, no `<style>` element and no `style=` or `on*=` attribute; the page's content-security-policy header equal to the literal `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`; the served script status 200 and its body handling the `span` event (contains the string `'span'` in its event dispatch); server.close() after
