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
  readonly droppedBatches: number;
  readonly droppedItems: number;
  readonly exportedItems: number;
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
  /** Answers the held first request with 200. */
  release(): void;
  stop(): Promise<void>;
};

/** A 127.0.0.1 server that holds its first request open until release() and answers the rest 200. */
async function startHoldingServer(): Promise<TestServer> {
  const bodies: string[] = [];
  let held: ServerResponse | undefined;
  let released = false;
  let seen = 0;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seen += 1;
    const isFirst = seen === 1;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'POST') bodies.push(Buffer.concat(chunks).toString('utf8'));
      if (isFirst && !released) {
        held = response;
        return;
      }
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
    release: () => {
      released = true;
      if (held !== undefined) {
        held.statusCode = 200;
        held.end();
        held = undefined;
      }
    },
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

/** The span id of s<index>. */
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

function range(from: number, to: number): string[] {
  const ids: string[] = [];
  for (let index = from; index <= to; index += 1) ids.push(spanId(index));
  return ids;
}

describe('otel span batching — AC-4', () => {
  it('AC-4: on overflow the oldest pending spans are dropped, counted, and reported a few times as "dropped"', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const server = await startHoldingServer();
    const errors: unknown[] = [];
    const exporter = otel.createOtlpTraceExporter({
      url: server.url,
      maxQueueSize: 5,
      maxBatchSize: 5,
      flushIntervalMs: 60_000,
      onError: (error) => {
        errors.push(error);
      },
    });
    try {
      for (let index = 0; index <= 4; index += 1) exporter.listener.span(makeSpan(index));
      await waitFor(() => server.bodies.length >= 1, 5000);
      expect(server.bodies.length).toBeGreaterThanOrEqual(1);

      for (let index = 5; index <= 104; index += 1) exporter.listener.span(makeSpan(index));
      server.release();
      await exporter.flush();

      const seen = server.bodies.flatMap((body) => spanIdsOf(body));
      expect([...seen].sort()).toEqual([...range(0, 4), ...range(100, 104)].sort());
      const lost = new Set(range(5, 99));
      expect(seen.filter((id) => lost.has(id))).toEqual([]);

      expect(exporter.droppedItems).toBe(95);
      expect(Number.isInteger(exporter.droppedItems)).toBe(true);
      expect(exporter.droppedBatches).toBe(95);
      expect(Number.isInteger(exporter.droppedBatches)).toBe(true);
      expect(exporter.exportedItems).toBe(10);

      const dropReports = errors.filter(
        (error): error is Error => error instanceof Error && error.message.includes('dropped'),
      );
      expect(dropReports.length).toBeGreaterThanOrEqual(1);
      expect(dropReports.length).toBeLessThanOrEqual(5);
    } finally {
      server.release();
      await exporter.close();
      await server.stop();
    }
  }, 30_000);
});
