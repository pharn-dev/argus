import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { AggregatedWindow, SpanRecord } from '../collector/index.js';
import { createOtlpMetricsExporter } from './otlp-exporter.js';
import { createOtlpTraceExporter } from './otlp-trace-exporter.js';

// Generous for a loaded CI runner, far below what the unbounded behaviour took (batches × timeout).
const EPSILON_MS = 400;
const SECRET = 'x-api-key-value-must-not-leak';

type Started = { server: Server; url: string; requests: () => number; stop: () => Promise<void> };

async function listen(handler: Parameters<typeof createServer>[1]): Promise<Started> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    handler?.(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}/v1/metrics`,
    requests: () => requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeWindow(start: number): AggregatedWindow {
  return {
    start,
    end: start + 1000,
    count: 1,
    late: 0,
    eventLoop: { max: 1, p99: 1, mean: 1 },
    memory: { heapUsedLast: 1, heapUsedMax: 1, rssLast: 1, rssMax: 1 },
    gc: { count: 0, totalPause: 0, maxPause: 0 },
    backpressure: { events: 0, totalStall: 0, maxStall: 0 },
  };
}

describe('OTLP transport bounds (F-06)', () => {
  it.each([302, 307, 308])(
    'treats a %i redirect as a failed batch and never contacts the redirect target',
    async (status) => {
      const seenHeaders: string[] = [];
      const target = await listen((request, response) => {
        seenHeaders.push(String(request.headers['x-api-key']));
        request.resume();
        response.end('{}');
      });
      const origin = await listen((request, response) => {
        request.resume();
        response.writeHead(status, { location: target.url });
        response.end();
      });
      try {
        const errors: Error[] = [];
        const exporter = createOtlpMetricsExporter({
          url: `${origin.url}?token=${SECRET}`,
          headers: { 'x-api-key': SECRET },
          onError: (error) => errors.push(error),
        });
        exporter.export(makeWindow(0));
        await exporter.close();
        expect(target.requests()).toBe(0);
        expect(seenHeaders).toHaveLength(0);
        expect(exporter.failedBatches).toBe(1);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.message).toContain(`redirect (status ${status}) not followed`);
        expect(errors[0]?.message).not.toContain(SECRET);
      } finally {
        await origin.stop();
        await target.stop();
      }
    },
  );

  it('reads at most a small cap of a huge response body and cancels the rest', async () => {
    const total = 64 * 1024 * 1024;
    let written = 0;
    let settle: (finished: boolean) => void = () => undefined;
    const responseClosed = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const server = await listen((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-length': String(total) });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        response.on('close', () => settle(response.writableFinished));
        const pump = (): void => {
          while (written < total && !response.destroyed) {
            written += chunk.length;
            if (!response.write(chunk)) {
              response.once('drain', pump);
              return;
            }
          }
          if (written >= total) response.end();
        };
        pump();
      });
    });
    try {
      const errors: Error[] = [];
      const exporter = createOtlpMetricsExporter({
        url: server.url,
        onError: (error) => errors.push(error),
      });
      exporter.export(makeWindow(0));
      await exporter.flush();
      const finished = await responseClosed;
      expect(finished).toBe(false); // the client cancelled the body: the connection closed early
      expect(written).toBeLessThan(total / 2);
      expect(exporter.failedBatches).toBe(0);
      expect(errors).toHaveLength(0);
      await exporter.close();
    } finally {
      await server.stop();
    }
  }, 20_000);
});

describe('OTLP bounded close (F-08)', () => {
  it('close() with 10 queued batches against a hanging endpoint drops them after closeTimeoutMs', async () => {
    const server = await listen((request) => {
      request.resume();
    });
    try {
      const errors: Error[] = [];
      const exporter = createOtlpMetricsExporter({
        url: server.url,
        timeoutMs: 10_000,
        closeTimeoutMs: 200,
        queueCapacity: 16,
        onError: (error) => errors.push(error),
      });
      exporter.export(makeWindow(0));
      await until(() => server.requests() === 1);
      for (let i = 1; i <= 10; i += 1) exporter.export(makeWindow(i * 1000));
      const started = Date.now();
      await exporter.close();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(200 + EPSILON_MS);
      expect(exporter.droppedBatches).toBe(10);
      expect(exporter.failedBatches).toBe(1);
      expect(server.requests()).toBe(1);
      const messages = errors.map((error) => error.message);
      expect(messages.some((message) => message.includes('dropped 10 queued batch'))).toBe(true);
      expect(messages.some((message) => message.includes('aborted by close()'))).toBe(true);
      // Idempotent, and a batch pushed after close is dropped.
      await exporter.close();
      exporter.export(makeWindow(99_000));
      expect(exporter.droppedBatches).toBe(11);
    } finally {
      await server.stop();
    }
  }, 15_000);

  it('close() with the default closeTimeoutMs completes within one request timeout', async () => {
    const server = await listen((request) => {
      request.resume();
    });
    try {
      const exporter = createOtlpTraceExporter({
        url: server.url,
        timeoutMs: 400,
        queueCapacity: 16,
        onError: () => undefined,
      });
      const span: SpanRecord = {
        type: 'span',
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        name: 'GET /users',
        method: 'GET',
        path: '/users',
        statusCode: 200,
        startTimeMs: 1700000000000,
        durationNs: 1000,
      };
      exporter.export(span);
      await until(() => server.requests() === 1);
      for (let i = 0; i < 10; i += 1) exporter.export(span);
      const started = Date.now();
      await exporter.close();
      expect(Date.now() - started).toBeLessThan(400 + EPSILON_MS);
      expect(exporter.droppedBatches + exporter.failedBatches).toBe(11);
      expect(exporter.droppedBatches).toBeGreaterThanOrEqual(9);
    } finally {
      await server.stop();
    }
  }, 15_000);

  it('close() still drains a responsive endpoint completely', async () => {
    const server = await listen((request, response) => {
      request.resume();
      request.on('end', () => response.end('{}'));
    });
    try {
      const exporter = createOtlpMetricsExporter({ url: server.url, queueCapacity: 16 });
      for (let i = 0; i < 8; i += 1) exporter.export(makeWindow(i * 1000));
      await exporter.close();
      expect(server.requests()).toBe(8);
      expect(exporter.droppedBatches).toBe(0);
      expect(exporter.failedBatches).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it('rejects a negative closeTimeoutMs', () => {
    expect(() =>
      createOtlpMetricsExporter({ url: 'http://127.0.0.1:1', closeTimeoutMs: -1 }),
    ).toThrow(RangeError);
  });
});
