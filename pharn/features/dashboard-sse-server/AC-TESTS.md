---
spec_id: dashboard-sse-server
spec_content_hash: dca6f9b42960a3e356d7c7a46890b97f0731c85ec4fcf2d8dbfd5e589c9e40b0
---

## Files

- `src/dashboard/dashboard-sse-server.ac1.integration.test.ts` — the tests for AC-1
- `src/dashboard/dashboard-sse-server.ac2.integration.test.ts` — the tests for AC-2
- `src/dashboard/dashboard-sse-server.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/dashboard/dashboard-sse-server.ac1.integration.test.ts` | route GET /events on src/dashboard/index.ts#createDashboardServer(options: { collector: Collector; host: string; port: number; token?: string; heartbeatMs?: number; maxBufferedEvents?: number; onError?: (error: Error) => void }): Promise<DashboardServer> — DashboardServer = { host: string; port: number; url: string; clientCount: number; droppedEvents: number; close(): Promise<void> }; collector from src/collector/index.ts#createCollector({ windowMs, capacity, alerts }) fed via consume(Readable.from(samples)) before and after connecting; observed: status, content-type, `event:`/`data:` lines parsed as JSON against collector.windows.snapshot() and collector.alerts.snapshot(), and a `:` heartbeat line, on host 127.0.0.1 port 0 with a short heartbeatMs
- AC-2 | integration | `src/dashboard/dashboard-sse-server.ac2.integration.test.ts` | route GET /events on src/dashboard/index.ts#createDashboardServer(options) — rejects for host 0.0.0.0 without token (error message mentions "token", no server listening); on 127.0.0.1 port 0 with token 's3cret': no credentials, `Authorization: Bearer wrong`, `?token=wrong` → 401 with no `event:` line in the body; `Authorization: Bearer s3cret`, `?token=s3cret` → 200 with content-type text/event-stream
- AC-3 | integration | `src/dashboard/dashboard-sse-server.ac3.integration.test.ts` | route GET /events on src/dashboard/index.ts#createDashboardServer(options) with a small maxBufferedEvents on 127.0.0.1 port 0, no token — one raw node:net client that sends the GET then pause()s and never reads, one reading client; the collector produces many windows via consume(); observed: the reading client's `event: window` data equals each new window, collector.windows.snapshot() holds the newest windows, server.droppedEvents is a positive integer or the stalled socket is closed by the server; then close() resolves, every open SSE response ends, and a new connection to the port is refused
