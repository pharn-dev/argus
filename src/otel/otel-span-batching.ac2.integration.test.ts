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
  createOtlpTraceExporter: (options: {
    url: string;
    onError?: (error: Error) => void;
    flushIntervalMs?: number;
    maxBatchSize?: number;
    maxQueueSize?: number;
  }) => TraceExporter;
};

type TracesBody = {
  resourceSpans?: { scopeSpans?: { spans?: { spanId?: string }[] }[] }[];
};

type TestServer = {
  readonly url: string;
  readonly bodies: string[];
  /** The largest number of requests that were open at the same time. */
  maxOpen(): number;
  stop(): Promise<void>;
};

/** A 127.0.0.1 server that answers 200, records each POST body and tracks requests open at once. */
async function startServer(): Promise<TestServer> {
  const bodies: string[] = [];
  let open = 0;
  let maxOpen = 0;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    open += 1;
    if (open > maxOpen) maxOpen = open;
    response.on('finish', () => {
      open -= 1;
    });
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
    maxOpen: () => maxOpen,
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

function spanId(index: number): string {
  return (index + 1).toString(16).padStart(16, '0');
}

function makeSpan(index: number): SpanRecord {
  return {
    type: 'span',
    traceId: TRACE_ID,
    spanId: spanId(index),
    name: 'GET /orders',
    method: 'GET',
    path: '/orders',
    statusCode: 200,
    startTimeMs: 1700000000000 + index,
    durationNs: 2000000,
  };
}

describe('otel span batching — AC-2', () => {
  it('AC-2: a full batch is sent at once, in order, one request at a time, and the rest waits for flush', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const server = await startServer();
    const exporter = otel.createOtlpTraceExporter({
      url: server.url,
      maxBatchSize: 10,
      flushIntervalMs: 60_000,
    });
    try {
      const ids: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        ids.push(spanId(index));
        exporter.listener.span(makeSpan(index));
      }

      await waitFor(() => server.bodies.length >= 2, 2000);
      // Give a spurious third request the chance to show up before the flush.
      await delay(100);
      const beforeFlush = [...server.bodies];
      expect(beforeFlush).toHaveLength(2);
      const first = spanIdsOf(beforeFlush[0] ?? '{}');
      const second = spanIdsOf(beforeFlush[1] ?? '{}');
      expect(first).toHaveLength(10);
      expect(second).toHaveLength(10);
      expect([...first, ...second]).toEqual(ids.slice(0, 20));

      await exporter.flush();

      expect(server.bodies).toHaveLength(3);
      expect(spanIdsOf(server.bodies[2] ?? '{}')).toEqual(ids.slice(20, 25));
      expect(server.maxOpen()).toBeLessThanOrEqual(1);
    } finally {
      await exporter.close();
      await server.stop();
    }
  }, 30_000);
});
