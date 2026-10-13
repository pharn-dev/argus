import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
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

type TraceExporter = {
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly listener: { span(span: SpanRecord): void };
};

type OtelModule = {
  createOtlpTraceExporter: (options: { url: string }) => TraceExporter;
};

type TracesBody = {
  resourceSpans?: { scopeSpans?: { spans?: { spanId?: string }[] }[] }[];
};

type TestServer = {
  readonly url: string;
  readonly bodies: string[];
  stop(): Promise<void>;
};

/** A 127.0.0.1 server that answers 200 and records each POST body. */
async function startServer(): Promise<TestServer> {
  const bodies: string[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'POST') bodies.push(Buffer.concat(chunks).toString('utf8'));
      response.statusCode = 200;
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
    bodies,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function spanIdsOf(body: string): string[] {
  const parsed = JSON.parse(body) as TracesBody;
  const ids: string[] = [];
  for (const resource of parsed.resourceSpans ?? []) {
    for (const scope of resource.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) ids.push(span.spanId ?? '');
    }
  }
  return ids;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(10);
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

describe('otel span batching — AC-3', () => {
  it('AC-3: with neither flush nor close, the flush timer sends the pending spans in one POST within 2500 ms', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const server = await startServer();
    const exporter = otel.createOtlpTraceExporter({ url: server.url });
    try {
      const ids = ['00f067aa0ba902b7', 'b7ad6b7169203331', '53995c3f42cd8ad8'];
      ids.forEach((id, offset) => {
        exporter.listener.span(makeSpan(id, offset));
      });

      const startedAt = Date.now();
      await waitFor(() => server.bodies.length >= 1, 2500);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(2500);
      // Let any further request for the same spans arrive before counting.
      await delay(200);

      expect(server.bodies).toHaveLength(1);
      expect(spanIdsOf(server.bodies[0] ?? '{}').sort()).toEqual([...ids].sort());
    } finally {
      await exporter.close();
      await server.stop();
    }
  }, 30_000);
});
