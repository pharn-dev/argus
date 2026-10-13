import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
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

type MetricsExporter = {
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly droppedItems: number;
  readonly listener: { window(window: Window): void };
};

type OtelModule = {
  createOtlpMetricsExporter: (options: {
    url: string;
    onError?: (error: Error) => void;
    flushIntervalMs?: number;
    maxBatchSize?: number;
    maxQueueSize?: number;
  }) => MetricsExporter;
};

type MetricsBody = {
  resourceMetrics?: {
    scopeMetrics?: {
      metrics?: { name?: string; gauge?: { dataPoints?: { timeUnixNano?: string }[] } }[];
    }[];
  }[];
};

type TestServer = {
  readonly url: string;
  readonly bodies: string[];
  /** Answers the held first request with 200 (a no-op when nothing is held). */
  release(): void;
  stop(): Promise<void>;
};

/**
 * A 127.0.0.1 server that records each POST body. With `holdFirst` it holds its first request open
 * until release() and answers the rest 200; otherwise it answers every request 200 after `delayMs`.
 */
async function startServer(options: { holdFirst: boolean; delayMs: number }): Promise<TestServer> {
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
      if (options.holdFirst && isFirst && !released) {
        held = response;
        return;
      }
      setTimeout(() => {
        response.statusCode = 200;
        response.end();
      }, options.delayMs);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/metrics`,
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

/** The `timeUnixNano` of every `phargus.event_loop.lag.max` data point in one request body. */
function lagMaxTimes(body: string): string[] {
  const parsed = JSON.parse(body) as MetricsBody;
  const times: string[] = [];
  for (const resource of parsed.resourceMetrics ?? []) {
    for (const scope of resource.scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        if (metric.name !== 'phargus.event_loop.lag.max') continue;
        for (const point of metric.gauge?.dataPoints ?? []) times.push(point.timeUnixNano ?? '');
      }
    }
  }
  return times;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(10);
}

const BASE_MS = 1700000000000;

/** Window w<index>: a one-second window whose end time is distinct per index. */
function makeWindow(index: number): Window {
  const start = BASE_MS + index * 1000;
  return {
    start,
    end: start + 1000,
    count: 10,
    late: 0,
    eventLoop: { max: 5000000 + index, p99: 4000000, mean: 2000000 },
    memory: { heapUsedLast: 1000, heapUsedMax: 2000, rssLast: 3000, rssMax: 4000 },
    gc: { count: 1, totalPause: 0, maxPause: 0 },
    backpressure: { events: 0, totalStall: 0, maxStall: 0 },
  };
}

/** A window end time (ms) as OTLP `timeUnixNano`: nanoseconds as a decimal string. */
function endNanos(index: number): string {
  return (BigInt(makeWindow(index).end) * 1_000_000n).toString();
}

describe('otel span batching — AC-5', () => {
  it('AC-5: the metrics exporter batches windows and drops the oldest ones on overflow', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;

    // (a) 100 windows against a 5 ms endpoint, default batching options.
    const fast = await startServer({ holdFirst: false, delayMs: 5 });
    const exporterA = otel.createOtlpMetricsExporter({ url: fast.url });
    try {
      const expected: string[] = [];
      for (let index = 1; index <= 100; index += 1) {
        expected.push(endNanos(index));
        exporterA.listener.window(makeWindow(index));
      }
      await exporterA.flush();

      expect(fast.bodies.length).toBeGreaterThanOrEqual(1);
      expect(fast.bodies.length).toBeLessThanOrEqual(5);
      const times = fast.bodies.flatMap((body) => lagMaxTimes(body));
      expect(times).toHaveLength(100);
      expect([...times].sort()).toEqual([...expected].sort());
      expect(exporterA.droppedItems).toBe(0);
    } finally {
      await exporterA.close();
      await fast.stop();
    }

    // (b) a held first request, a queue of 4, and 14 windows: w5..w10 are the oldest and are dropped.
    const holding = await startServer({ holdFirst: true, delayMs: 0 });
    const exporterB = otel.createOtlpMetricsExporter({
      url: holding.url,
      maxQueueSize: 4,
      maxBatchSize: 4,
      flushIntervalMs: 60_000,
    });
    try {
      for (let index = 1; index <= 4; index += 1) exporterB.listener.window(makeWindow(index));
      await waitFor(() => holding.bodies.length >= 1, 5000);
      expect(holding.bodies.length).toBeGreaterThanOrEqual(1);

      for (let index = 5; index <= 14; index += 1) exporterB.listener.window(makeWindow(index));
      holding.release();
      await exporterB.flush();

      const kept = [1, 2, 3, 4, 11, 12, 13, 14].map((index) => endNanos(index));
      const times = holding.bodies.flatMap((body) => lagMaxTimes(body));
      expect([...times].sort()).toEqual([...kept].sort());
      expect(exporterB.droppedItems).toBe(6);
      expect(Number.isInteger(exporterB.droppedItems)).toBe(true);
    } finally {
      holding.release();
      await exporterB.close();
      await holding.stop();
    }
  }, 30_000);
});
