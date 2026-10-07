import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type SpanRecord = {
  type: 'span';
  traceId: string;
  spanId: string;
  name: string;
  method: string;
  path: string;
  statusCode: number;
  startTimeMs: number;
  durationNs: number;
};

type Listener = { span?(span: SpanRecord): void };

type TraceExporter = {
  export(spans: SpanRecord | readonly SpanRecord[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly droppedBatches: number;
  readonly failedBatches: number;
  readonly listener: Listener;
};

type OtelModule = {
  createOtlpTraceExporter: (options: {
    url: string;
    headers?: Record<string, string>;
    serviceName?: string;
    timeoutMs?: number;
    queueCapacity?: number;
    onError?: (error: Error) => void;
  }) => TraceExporter;
};

type CollectorUnderTest = {
  subscribe(listener: Listener): () => void;
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
  close(): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: { windowMs: number; capacity: number }) => CollectorUnderTest;
};

type TracesRequest = {
  resourceSpans?: { scopeSpans?: { spans?: { traceId?: string; spanId?: string }[] }[] }[];
};

type ReceivedRequest = {
  method: string | undefined;
  path: string | undefined;
  contentType: string | undefined;
  apiKey: string | string[] | undefined;
  body: string;
};

type TestServer = {
  readonly url: string;
  readonly received: ReceivedRequest[];
  stop(): Promise<void>;
};

async function startServer(status: number): Promise<TestServer> {
  const received: ReceivedRequest[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method,
        path: request.url,
        contentType: request.headers['content-type'],
        apiKey: request.headers['x-api-key'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.statusCode = status;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    received,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

function makeSpan(spanId: string, offset: number): SpanRecord {
  return {
    type: 'span',
    traceId: TRACE_ID,
    spanId,
    name: 'GET /orders',
    method: 'GET',
    path: '/orders',
    statusCode: 200,
    startTimeMs: 1700000000000 + offset,
    durationNs: 2000000,
  };
}

describe('otel trace export — AC-2', () => {
  it('AC-2: a subscribed exporter POSTs the collector span records to /v1/traces with the caller headers', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const collectorModule = (await import('../collector/index.js')) as unknown as CollectorModule;
    const server = await startServer(200);
    try {
      const errors: Error[] = [];
      const exporter = otel.createOtlpTraceExporter({
        url: server.url,
        headers: { 'x-api-key': 'test-key' },
        timeoutMs: 2000,
        onError: (error) => {
          errors.push(error);
        },
      });
      const collector = collectorModule.createCollector({ windowMs: 1000, capacity: 16 });
      try {
        collector.subscribe(exporter.listener);
        const first = makeSpan('00f067aa0ba902b7', 0);
        const second = makeSpan('b7ad6b7169203331', 5);
        await collector.consume(Readable.from([first, second]));
        await exporter.flush();

        expect(server.received.length).toBeGreaterThanOrEqual(1);
        const seen: { traceId: string | undefined; spanId: string | undefined }[] = [];
        for (const request of server.received) {
          expect(request.method).toBe('POST');
          expect(request.path).toBe('/v1/traces');
          expect(request.contentType).toMatch(/^application\/json\b/);
          expect(request.apiKey).toBe('test-key');
          const body = JSON.parse(request.body) as TracesRequest;
          for (const resource of body.resourceSpans ?? []) {
            for (const scope of resource.scopeSpans ?? []) {
              for (const span of scope.spans ?? []) {
                seen.push({ traceId: span.traceId, spanId: span.spanId });
              }
            }
          }
        }
        expect(seen.map((span) => span.spanId).sort()).toEqual([
          '00f067aa0ba902b7',
          'b7ad6b7169203331',
        ]);
        for (const span of seen) expect(span.traceId).toBe(TRACE_ID);

        expect(exporter.droppedBatches).toBe(0);
        expect(errors).toHaveLength(0);
      } finally {
        await collector.close();
        await exporter.close();
      }
    } finally {
      await server.stop();
    }
  }, 15_000);
});
