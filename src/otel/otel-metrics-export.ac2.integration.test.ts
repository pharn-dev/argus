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

type DataPoint = { startTimeUnixNano?: string; timeUnixNano: string; asInt: string };

type Metric = {
  name: string;
  gauge?: { dataPoints: DataPoint[] };
  sum?: { dataPoints: DataPoint[] };
};

type MetricsRequest = {
  resourceMetrics: { scopeMetrics: { metrics: Metric[] }[] }[];
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

type ReceivedRequest = {
  method: string | undefined;
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
    url: `http://127.0.0.1:${port}/v1/metrics`,
    received,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function makeWindow(start: number, lagMax: number, gcCount: number): Window {
  return {
    start,
    end: start + 1000,
    count: 10,
    late: 0,
    eventLoop: { max: lagMax, p99: 4000000, mean: 2000000 },
    memory: { heapUsedLast: 1000, heapUsedMax: 2000, rssLast: 3000, rssMax: 4000 },
    gc: { count: gcCount, totalPause: 0, maxPause: 0 },
    backpressure: { events: 0, totalStall: 0, maxStall: 0 },
  };
}

describe('otel metrics export — AC-2', () => {
  it('AC-2: exports one batch of two windows as a single JSON POST with the caller headers', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const server = await startServer(200);
    try {
      const errors: Error[] = [];
      const exporter = otel.createOtlpMetricsExporter({
        url: server.url,
        headers: { 'x-api-key': 'test-key' },
        timeoutMs: 2000,
        onError: (error) => {
          errors.push(error);
        },
      });
      const first = makeWindow(1700000000000, 5000000, 7);
      const second = makeWindow(1700000001000, 6000000, 9);
      exporter.export([first, second]);
      await exporter.flush();

      expect(server.received).toHaveLength(1);
      const request = server.received[0];
      expect(request?.method).toBe('POST');
      expect(request?.contentType).toMatch(/^application\/json\b/);
      expect(request?.apiKey).toBe('test-key');

      const body = JSON.parse(request?.body ?? '') as MetricsRequest;
      const metrics = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
      const byName = new Map(metrics.map((metric) => [metric.name, metric]));

      const lagPoints = byName.get('argus.event_loop.lag.max')?.gauge?.dataPoints ?? [];
      expect(lagPoints.map((point) => point.asInt)).toEqual(['5000000', '6000000']);
      expect(lagPoints.map((point) => point.timeUnixNano)).toEqual([
        '1700000001000000000',
        '1700000002000000000',
      ]);
      const gcPoints = byName.get('argus.gc.count')?.sum?.dataPoints ?? [];
      expect(gcPoints.map((point) => point.asInt)).toEqual(['7', '9']);

      expect(exporter.droppedBatches).toBe(0);
      expect(errors).toHaveLength(0);
      await exporter.close();
    } finally {
      await server.stop();
    }
  }, 15_000);
});
