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
  readonly failedBatches: number;
  readonly exportedItems: number;
  readonly failedItems: number;
  readonly listener: { span(span: SpanRecord): void };
};

type OtelModule = {
  createOtlpTraceExporter: (options: {
    url: string;
    onError?: (error: Error) => void;
  }) => TraceExporter;
};

type TestServer = {
  readonly url: string;
  stop(): Promise<void>;
};

/** A 127.0.0.1 server that answers every request with `status`. */
async function startServer(status: number): Promise<TestServer> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
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
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The URL of a 127.0.0.1 port nothing listens on: a server is bound, then closed. */
async function unusedPortUrl(): Promise<string> {
  const server = await startServer(200);
  const { url } = server;
  await server.stop();
  return url;
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

type Outcome = { errors: unknown[]; exporter: TraceExporter };

/** Passes 3 spans to the listener and flushes, asserting neither throws nor rejects. */
async function exportThree(otel: OtelModule, url: string): Promise<Outcome> {
  const errors: unknown[] = [];
  const exporter = otel.createOtlpTraceExporter({
    url,
    onError: (error) => {
      errors.push(error);
    },
  });
  expect(() => {
    for (let index = 0; index < 3; index += 1) exporter.listener.span(makeSpan(index));
  }).not.toThrow();
  await expect(exporter.flush()).resolves.toBeUndefined();
  return { errors, exporter };
}

function expectFailedOnce({ errors, exporter }: Outcome): void {
  expect(exporter.failedBatches).toBe(1);
  expect(exporter.failedItems).toBe(3);
  expect(exporter.exportedItems).toBe(0);
  expect(errors.some((error) => error instanceof Error)).toBe(true);
}

describe('otel span batching — AC-8', () => {
  it('AC-8: a 500 answer and a refused connection are counted as one failed batch of 3 items and reported, never thrown', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // (a) the endpoint answers 500.
      const server = await startServer(500);
      try {
        const outcome = await exportThree(otel, server.url);
        try {
          expectFailedOnce(outcome);
          expect(
            outcome.errors.some((error) => error instanceof Error && error.message.includes('500')),
          ).toBe(true);
        } finally {
          await outcome.exporter.close();
        }
      } finally {
        await server.stop();
      }

      // (b) nothing listens on the port.
      const outcome = await exportThree(otel, await unusedPortUrl());
      try {
        expectFailedOnce(outcome);
      } finally {
        await outcome.exporter.close();
      }

      // Let any rejection left unobserved surface before checking.
      await delay(50);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 30_000);
});
