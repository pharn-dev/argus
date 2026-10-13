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
  readonly droppedItems: number;
  readonly listener: { span(span: SpanRecord): void };
};

type OtelModule = {
  createOtlpTraceExporter: (options: { url: string; flushIntervalMs?: number }) => TraceExporter;
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

describe('otel span batching — AC-6', () => {
  it('AC-6: close() sends what is pending in one POST, a later span is dropped and counted, and close is idempotent', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const server = await startServer();
    const exporter = otel.createOtlpTraceExporter({ url: server.url, flushIntervalMs: 60_000 });
    try {
      const ids = ['00f067aa0ba902b7', 'b7ad6b7169203331', '53995c3f42cd8ad8'];
      ids.forEach((id, offset) => {
        exporter.listener.span(makeSpan(id, offset));
      });

      await expect(exporter.close()).resolves.toBeUndefined();
      const afterFirstClose = [...server.bodies];
      expect(afterFirstClose).toHaveLength(1);
      expect(spanIdsOf(afterFirstClose[0] ?? '{}').sort()).toEqual([...ids].sort());

      const lateId = 'e457b5a2e4d86bd1';
      exporter.listener.span(makeSpan(lateId, 10));
      await expect(exporter.close()).resolves.toBeUndefined();
      // Give a late request the chance to arrive before asserting it never does.
      await delay(200);

      const seen = server.bodies.flatMap((body) => spanIdsOf(body));
      expect(seen).not.toContain(lateId);
      expect(exporter.droppedItems).toBe(1);
    } finally {
      await exporter.close();
      await server.stop();
    }
  }, 30_000);
});
