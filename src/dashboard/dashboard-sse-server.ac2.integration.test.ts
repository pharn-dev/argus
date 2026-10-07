import { request as httpRequest } from 'node:http';
import { connect, createServer, type AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type CollectorUnderTest = {
  readonly windows: { snapshot(): unknown[] };
  readonly alerts: { snapshot(): unknown[] };
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: { windowMs: number; capacity: number }) => CollectorUnderTest;
};

type DashboardServerUnderTest = {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly clientCount: number;
  readonly droppedEvents: number;
  close(): Promise<void>;
};

type DashboardModule = {
  createDashboardServer: (options: {
    collector: CollectorUnderTest;
    host: string;
    port: number;
    token?: string;
    heartbeatMs?: number;
    maxBufferedEvents?: number;
    onError?: (error: Error) => void;
  }) => Promise<DashboardServerUnderTest>;
};

type Outcome = { status: number; contentType: string; body: string };

/** A full AgentSample-shaped object at the given timestamp. */
function makeSample(timestamp: number): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: 20, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 100, heapTotal: 200, rss: 1000, external: 0, arrayBuffers: 0 },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  };
}

/** Finds a TCP port that is free right now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '0.0.0.0', () => resolve());
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

/** Resolves with the connection error code, or 'connected' when something is listening. */
function probeConnect(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error.code ?? 'error');
    });
  });
}

/**
 * Issues one GET. A 200 resolves as soon as its headers arrive (an SSE stream never ends) and the
 * request is then destroyed; any other status is read to its end.
 */
function getOnce(port: number, path: string, headers: Record<string, string>): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers['content-type'] ?? '');
      if (status === 200) {
        req.destroy();
        resolve({ status, contentType, body: '' });
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status, contentType, body }));
      res.on('error', reject);
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNRESET') {
        return;
      }
      reject(error);
    });
    req.setTimeout(5_000, () => {
      req.destroy(new Error(`GET ${path} timed out`));
    });
    req.end();
  });
}

describe('dashboard SSE server — AC-2', () => {
  it('AC-2: refuses a non-loopback host without a token, and gates /events behind the token', async () => {
    const collectorModule = (await import('../collector/index.js')) as unknown as CollectorModule;
    const dashboardModule = (await import('./index.js')) as unknown as DashboardModule;

    const collector = collectorModule.createCollector({ windowMs: 1000, capacity: 10 });
    await collector.consume(Readable.from([makeSample(100), makeSample(1100)]));

    const port = await freePort();
    let refused: unknown;
    let unexpected: DashboardServerUnderTest | undefined;
    try {
      unexpected = await (async () =>
        dashboardModule.createDashboardServer({ collector, host: '0.0.0.0', port }))();
    } catch (error) {
      refused = error;
    }
    if (unexpected !== undefined) {
      await unexpected.close();
    }
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/token/i);
    expect(await probeConnect(port)).toBe('ECONNREFUSED');

    let server: DashboardServerUnderTest | undefined;
    try {
      server = await dashboardModule.createDashboardServer({
        collector,
        host: '127.0.0.1',
        port: 0,
        token: 's3cret',
        heartbeatMs: 1_000,
      });
      const bound = server.port;

      const unauthorized = [
        await getOnce(bound, '/events', {}),
        await getOnce(bound, '/events', { authorization: 'Bearer wrong' }),
        await getOnce(bound, '/events?token=wrong', {}),
        // The token is never accepted in the /events URL, even when it is right.
        await getOnce(bound, '/events?token=s3cret', {}),
      ];
      for (const outcome of unauthorized) {
        expect(outcome.status).toBe(401);
        expect(outcome.body).not.toMatch(/^event:/m);
      }

      const authorized = [await getOnce(bound, '/events', { authorization: 'Bearer s3cret' })];
      for (const outcome of authorized) {
        expect(outcome.status).toBe(200);
        expect(outcome.contentType).toMatch(/^text\/event-stream/);
      }
    } finally {
      await server?.close();
    }
  }, 20_000);
});
