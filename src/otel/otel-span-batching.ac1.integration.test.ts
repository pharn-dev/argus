import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  export(spans: SpanRecord | readonly SpanRecord[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly droppedBatches: number;
  readonly failedBatches: number;
  readonly droppedItems: number;
  readonly exportedItems: number;
  readonly failedItems: number;
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
  stop(): Promise<void>;
};

/** A 127.0.0.1 server that records each POST body and answers 200 after `delayMs`. */
async function startServer(delayMs: number): Promise<TestServer> {
  const bodies: string[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'POST') bodies.push(Buffer.concat(chunks).toString('utf8'));
      setTimeout(() => {
        response.statusCode = 200;
        response.end();
      }, delayMs);
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

/** The `spans[]` arrays of one request body, each as its list of span ids. */
function spanGroups(body: string): string[][] {
  const parsed = JSON.parse(body) as TracesBody;
  const groups: string[][] = [];
  for (const resource of parsed.resourceSpans ?? []) {
    for (const scope of resource.scopeSpans ?? []) {
      groups.push((scope.spans ?? []).map((span) => span.spanId ?? ''));
    }
  }
  return groups;
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

describe('otel span batching — AC-1', () => {
  it('AC-1: 500 spans through the listener reach a 5 ms endpoint coalesced in at most 5 POSTs with no loss', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const server = await startServer(5);
    const errors: unknown[] = [];
    const exporter = otel.createOtlpTraceExporter({
      url: server.url,
      onError: (error) => {
        errors.push(error);
      },
    });
    try {
      const expected: string[] = [];
      for (let index = 0; index < 500; index += 1) {
        expected.push(spanId(index));
        exporter.listener.span(makeSpan(index));
      }
      await exporter.flush();

      expect(server.bodies.length).toBeGreaterThanOrEqual(1);
      expect(server.bodies.length).toBeLessThanOrEqual(5);

      const groups = server.bodies.flatMap((body) => spanGroups(body));
      expect(groups.some((group) => group.length > 1)).toBe(true);

      const seen = groups.flat();
      expect(seen).toHaveLength(500);
      expect(new Set(seen).size).toBe(500);
      expect([...seen].sort()).toEqual([...expected].sort());

      expect(exporter.droppedItems).toBe(0);
      expect(exporter.droppedBatches).toBe(0);
      expect(exporter.failedBatches).toBe(0);
      expect(exporter.exportedItems).toBe(500);
      expect(errors).toHaveLength(0);
    } finally {
      await exporter.close();
      await server.stop();
    }
  }, 30_000);
});
