import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

type AlertOutput = {
  ruleId: string;
  metric: string;
  comparison: string;
  threshold: number;
  observed: number;
  windowStart: number;
  windowEnd: number;
  state: string;
};

type AlertSinkUnderTest = {
  readonly type: string;
  readonly name: string | undefined;
  readonly failed: number;
  readonly dropped: number;
  send(alert: AlertOutput): Promise<void>;
  close(): Promise<void>;
};

type SinkModule = {
  createWebhookSink: (options: {
    url: string;
    name?: string;
    timeoutMs?: number;
    retries?: number;
    backoffMs?: number;
    maxInFlight?: number;
    onError?: (error: Error, sink: AlertSinkUnderTest) => void;
  }) => AlertSinkUnderTest;
};

type ReceivedRequest = {
  method: string | undefined;
  contentType: string | undefined;
  body: string;
};

type TestServer = {
  readonly url: string;
  readonly received: ReceivedRequest[];
  stop(): Promise<void>;
};

/**
 * Starts a local node:http server on 127.0.0.1, port 0. `respond` gets the zero-based
 * request index and returns the status to answer with, or `undefined` to never answer.
 */
async function startServer(respond: (index: number) => number | undefined): Promise<TestServer> {
  const received: ReceivedRequest[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const index = received.length;
      received.push({
        method: request.method,
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const status = respond(index);
      if (status !== undefined) {
        response.statusCode = status;
        response.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/alerts`,
    received,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const alert: AlertOutput = {
  ruleId: 'loop-max',
  metric: 'eventLoop.max',
  comparison: '>',
  threshold: 100,
  observed: 500,
  windowStart: 1000,
  windowEnd: 2000,
  state: 'firing',
};

function expectJsonPost(request: ReceivedRequest | undefined): void {
  expect(request?.method).toBe('POST');
  expect(request?.contentType).toMatch(/^application\/json\b/);
  expect(JSON.parse(request?.body ?? '') as unknown).toEqual(alert);
}

describe('collector alert sinks — AC-2', () => {
  it('AC-2: the webhook sink POSTs JSON, retries a 5xx, counts a timeout as one failure, and drops past its in-flight bound', async () => {
    const sinkModule = (await import('./index.js')) as unknown as SinkModule;
    const errors: Error[] = [];
    const onError = (error: Error): void => {
      errors.push(error);
    };

    // 200 → one POST, no failure.
    const ok = await startServer(() => 200);
    try {
      const sink = sinkModule.createWebhookSink({ url: ok.url, timeoutMs: 2000, onError });
      await expect(sink.send(alert)).resolves.toBeUndefined();
      expect(ok.received).toHaveLength(1);
      expectJsonPost(ok.received[0]);
      expect(sink.failed).toBe(0);
      await sink.close();
    } finally {
      await ok.stop();
    }

    // 500 then 200 with one retry → two POSTs, no failure.
    const flaky = await startServer((index) => (index === 0 ? 500 : 200));
    try {
      const sink = sinkModule.createWebhookSink({
        url: flaky.url,
        timeoutMs: 2000,
        retries: 1,
        backoffMs: 10,
        onError,
      });
      await expect(sink.send(alert)).resolves.toBeUndefined();
      expect(flaky.received).toHaveLength(2);
      expectJsonPost(flaky.received[0]);
      expectJsonPost(flaky.received[1]);
      expect(sink.failed).toBe(0);
      await sink.close();
    } finally {
      await flaky.stop();
    }

    // Never answers, zero retries → send resolves within a bounded time, one failure.
    const silent = await startServer(() => undefined);
    try {
      const sink = sinkModule.createWebhookSink({
        url: silent.url,
        timeoutMs: 200,
        retries: 0,
        onError,
      });
      const started = Date.now();
      await expect(sink.send(alert)).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(3000);
      expect(sink.failed).toBe(1);
      await sink.close();
    } finally {
      await silent.stop();
    }

    // In-flight bound of 1 to a never-answering server → two of three sends dropped.
    const stalled = await startServer(() => undefined);
    try {
      const sink = sinkModule.createWebhookSink({
        url: stalled.url,
        timeoutMs: 300,
        retries: 0,
        maxInFlight: 1,
        onError,
      });
      const sends = [sink.send(alert), sink.send(alert), sink.send(alert)];
      await Promise.all(sends);
      expect(sink.dropped).toBe(2);
      await sink.close();
    } finally {
      await stalled.stop();
    }
  }, 15_000);
});
