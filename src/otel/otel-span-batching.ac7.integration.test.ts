import { createServer, type IncomingMessage, type Server } from 'node:http';
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
  readonly failedBatches: number;
  readonly droppedItems: number;
  readonly failedItems: number;
  readonly listener: { span(span: SpanRecord): void };
};

type OtelModule = {
  createOtlpTraceExporter: (options: {
    url: string;
    onError?: (error: Error) => void;
    flushIntervalMs?: number;
    maxBatchSize?: number;
    closeTimeoutMs?: number;
  }) => TraceExporter;
};

type TestServer = {
  readonly url: string;
  /** How many requests have arrived. */
  arrivals(): number;
  stop(): Promise<void>;
};

/** A 127.0.0.1 server that accepts requests, counts them, and never answers. */
async function startSilentServer(): Promise<TestServer> {
  let arrivals = 0;
  const server: Server = createServer((request: IncomingMessage) => {
    arrivals += 1;
    request.resume();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    arrivals: () => arrivals,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(10);
}

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

function makeSpan(index: number): SpanRecord {
  return {
    type: 'span',
    traceId: TRACE_ID,
    spanId: (index + 1).toString(16).padStart(16, '0'),
    name: 'GET /orders',
    method: 'GET',
    path: '/orders',
    statusCode: 200,
    startTimeMs: 1700000000000 + index,
    durationNs: 2000000,
  };
}

const TIMED_OUT = Symbol('timed out');

describe('otel span batching — AC-7', () => {
  it('AC-7: close() against a hung endpoint resolves within its bound, drops and reports what is pending', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const server = await startSilentServer();
    const errors: unknown[] = [];
    const exporter = otel.createOtlpTraceExporter({
      url: server.url,
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
      closeTimeoutMs: 200,
      onError: (error) => {
        errors.push(error);
      },
    });
    try {
      exporter.listener.span(makeSpan(0));
      exporter.listener.span(makeSpan(1));
      await waitFor(() => server.arrivals() >= 1, 5000);
      expect(server.arrivals()).toBe(1);

      exporter.listener.span(makeSpan(2));
      exporter.listener.span(makeSpan(3));
      exporter.listener.span(makeSpan(4));

      const startedAt = Date.now();
      const outcome = await Promise.race([
        exporter.close().then(() => 'resolved' as const),
        delay(2000).then(() => TIMED_OUT),
      ]);
      expect(outcome).toBe('resolved');
      expect(Date.now() - startedAt).toBeLessThan(2000);

      expect(server.arrivals()).toBe(1);
      expect(exporter.droppedItems).toBe(3);
      expect(exporter.failedItems).toBe(2);
      expect(exporter.failedBatches).toBe(1);
      expect(
        errors.some((error) => error instanceof Error && error.message.includes('dropped')),
      ).toBe(true);
    } finally {
      await server.stop();
    }
  }, 30_000);
});
