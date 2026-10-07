import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

type Window = {
  start: number;
  end: number;
  count: number;
  late: number;
  eventLoop: { max: number; p99: number; mean: number };
  memory: { heapUsedLast: number; heapUsedMax: number; rssLast: number; rssMax: number };
  gc: { count: number; totalPause: number; maxPause: number };
  backpressure: { events: number; totalStall: number; maxStall: number };
};

type Exporter = {
  export(windows: Window | readonly Window[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly droppedBatches: number;
  readonly failedBatches: number;
};

type OtelModule = {
  createOtlpMetricsExporter: (options: {
    url: string;
    headers?: Record<string, string>;
    serviceName?: string;
    timeoutMs?: number;
    queueCapacity?: number;
    onError?: (error: Error) => void;
  }) => Exporter;
};

type TestServer = {
  readonly url: string;
  /** Number of requests whose body has been fully received. */
  received(): number;
  /** Resolves once the first request has been fully received. */
  readonly firstArrived: Promise<void>;
  /** Answers every held request with 200. */
  release(): void;
  stop(): Promise<void>;
};

/**
 * Starts a local node:http server on 127.0.0.1, port 0, answering `status`. With `holdFirst`, the
 * first request is held open until `release()` is called; later requests are answered at once.
 */
async function startServer(status: number, holdFirst = false): Promise<TestServer> {
  let count = 0;
  const held: ServerResponse[] = [];
  let signalFirst: () => void = () => undefined;
  const firstArrived = new Promise<void>((resolve) => {
    signalFirst = resolve;
  });
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      count += 1;
      if (count === 1) signalFirst();
      if (holdFirst && count === 1) {
        held.push(response);
        return;
      }
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
    url: `http://127.0.0.1:${port}/v1/metrics`,
    received: () => count,
    firstArrived,
    release: () => {
      for (const response of held.splice(0)) {
        response.statusCode = 200;
        response.end();
      }
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Returns the URL of a 127.0.0.1 port that had a listener a moment ago and has none now. */
async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1/metrics`;
}

function makeWindow(start: number): Window {
  return {
    start,
    end: start + 1000,
    count: 10,
    late: 0,
    eventLoop: { max: 5000000, p99: 4000000, mean: 2000000 },
    memory: { heapUsedLast: 1000, heapUsedMax: 2000, rssLast: 3000, rssMax: 4000 },
    gc: { count: 7, totalPause: 0, maxPause: 0 },
    backpressure: { events: 0, totalStall: 0, maxStall: 0 },
  };
}

describe('otel metrics export — AC-3', () => {
  it('AC-3: reports a 500 response to the error callback without throwing or rejecting', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const server = await startServer(500);
    try {
      const errors: unknown[] = [];
      const exporter = otel.createOtlpMetricsExporter({
        url: server.url,
        queueCapacity: 1,
        timeoutMs: 2000,
        onError: (error) => {
          errors.push(error);
        },
      });
      expect(() => exporter.export([makeWindow(1700000000000)])).not.toThrow();
      await expect(exporter.flush()).resolves.toBeUndefined();
      expect(server.received()).toBe(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect((errors[0] as Error).message).toContain('500');
      await exporter.close();
    } finally {
      await server.stop();
    }
  }, 15_000);

  it('AC-3: reports a connection error to the error callback without throwing or rejecting', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const url = await closedPortUrl();
    const errors: unknown[] = [];
    const exporter = otel.createOtlpMetricsExporter({
      url,
      queueCapacity: 1,
      timeoutMs: 2000,
      onError: (error) => {
        errors.push(error);
      },
    });
    expect(() => exporter.export([makeWindow(1700000000000)])).not.toThrow();
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    await exporter.close();
  }, 15_000);

  it('AC-3: with queue capacity 1 and the first request held open, drops the third batch and sends two', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const server = await startServer(200, true);
    try {
      const errors: unknown[] = [];
      const exporter = otel.createOtlpMetricsExporter({
        url: server.url,
        queueCapacity: 1,
        timeoutMs: 5000,
        onError: (error) => {
          errors.push(error);
        },
      });
      exporter.export([makeWindow(1700000000000)]);
      await server.firstArrived;
      exporter.export([makeWindow(1700000001000)]);
      exporter.export([makeWindow(1700000002000)]);
      server.release();
      await exporter.flush();

      expect(server.received()).toBe(2);
      expect(exporter.droppedBatches).toBe(1);
      expect(Number.isInteger(exporter.droppedBatches)).toBe(true);
      expect(errors).toHaveLength(0);
      await exporter.close();
    } finally {
      await server.stop();
    }
  }, 15_000);
});
