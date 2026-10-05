---
spec_id: collector-alert-sinks
spec_content_hash: c6e745deefa7ef7adeb513f36a09c5df48210af2238c02ae670502fb85c83899
---

## Files

- `src/collector/collector-alert-sinks.ac1.integration.test.ts` — the tests for AC-1
- `src/collector/collector-alert-sinks.ac2.integration.test.ts` — the tests for AC-2
- `src/collector/collector-alert-sinks.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/collector/collector-alert-sinks.ac1.integration.test.ts` | src/collector/index.ts#createStdoutSink(options?: { stream?: Writable; name?: string; onError?: (error: Error, sink: AlertSink) => void }): AlertSink and src/collector/index.ts#createFileSink(options: { path: string; name?: string; onError?: (error: Error, sink: AlertSink) => void }): AlertSink — AlertSink = { type: string; name: string | undefined; failed: number; dropped: number; send(alert: Alert): Promise<void>; close(): Promise<void> }; a node:stream Writable collecting chunks (observed: lines, writableEnded false) and a file under fs.mkdtemp(os.tmpdir()) pre-written with one line (observed: fs.readFile lines); one firing and one resolved Alert sent to each, then close()
- AC-2 | integration | `src/collector/collector-alert-sinks.ac2.integration.test.ts` | src/collector/index.ts#createWebhookSink(options: { url: string; name?: string; timeoutMs?: number; retries?: number; backoffMs?: number; maxInFlight?: number; onError?: (error: Error, sink: AlertSink) => void }): AlertSink — against a local node:http server on 127.0.0.1 port 0 answering POST with 200, with 500 then 200 (retries 1, backoffMs short), and never (timeoutMs short, retries 0), observed via the server's received method, content-type header and JSON body, send() resolving, and the sink's failed counter; plus maxInFlight 1 to a never-answering server with three un-awaited send() calls, observed via the dropped counter
- AC-3 | integration | `src/collector/collector-alert-sinks.ac3.integration.test.ts` | src/collector/index.ts#createCollector(options: { windowMs: number; capacity: number; alerts?: readonly AlertRule[]; sinks?: readonly (AlertSink | SinkConfig)[]; onSinkError?: (error: Error, sink: AlertSink) => void }): Collector — SinkConfig = { type: 'stdout'; stream?; name? } | { type: 'file'; path; name? } | { type: 'webhook'; url; timeoutMs?; retries?; backoffMs?; maxInFlight?; name? }; consume(source: Readable | AsyncIterable<AgentSample>): Promise<void>; sinks: readonly AlertSink[] (input order); close(): Promise<void>; a Readable.from source across windows 0/1000/2000 with eventLoop.max 50/500/50, an in-memory Writable and an always-500 node:http server; plus synchronous throws from createCollector for type 'carrier-pigeon', a webhook url 'ftp://…', and a webhook timeoutMs 0, each message containing the sink's type
