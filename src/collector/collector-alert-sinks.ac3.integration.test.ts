import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type AlertRuleInput = {
  id: string;
  metric: string;
  comparison: string;
  threshold: number;
  forWindows?: number;
};

type AlertSinkUnderTest = {
  readonly type: string;
  readonly name: string | undefined;
  readonly failed: number;
  readonly dropped: number;
  send(alert: unknown): Promise<void>;
  close(): Promise<void>;
};

type SinkConfigInput = { type: string } & Record<string, unknown>;

type CollectorUnderTest = {
  readonly sinks: readonly AlertSinkUnderTest[];
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
  close(): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: {
    windowMs: number;
    capacity: number;
    alerts?: readonly AlertRuleInput[];
    sinks?: readonly SinkConfigInput[];
    onSinkError?: (error: Error, sink: AlertSinkUnderTest) => void;
  }) => CollectorUnderTest;
};

/** A full AgentSample-shaped object at the given timestamp with the given event-loop max. */
function makeSample(timestamp: number, eventLoopMax: number): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: eventLoopMax, mean: 10, p50: 9, p99: 18 },
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

const rules: AlertRuleInput[] = [
  { id: 'loop-max', metric: 'eventLoop.max', comparison: '>', threshold: 100 },
];

/** A local node:http server on 127.0.0.1, port 0, answering 500 to every request. */
async function startFailingServer(): Promise<{ url: string; stop(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/alerts`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('collector alert sinks — AC-3', () => {
  it('AC-3: a collector delivers every alert to every sink, isolates a failing sink, and rejects bad sink config at creation', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        callback();
      },
    });

    const server = await startFailingServer();
    try {
      const sinkErrors: Error[] = [];
      const collector = collectorModule.createCollector({
        windowMs: 1000,
        capacity: 10,
        alerts: rules,
        sinks: [
          { type: 'stdout', stream },
          { type: 'webhook', url: server.url, retries: 0, timeoutMs: 2000 },
        ],
        onSinkError: (error) => {
          sinkErrors.push(error);
        },
      });

      const source = Readable.from([
        makeSample(100, 50),
        makeSample(500, 40),
        makeSample(1100, 500),
        makeSample(1600, 300),
        makeSample(2100, 50),
        makeSample(2700, 20),
      ]);
      await expect(collector.consume(source)).resolves.toBeUndefined();

      const lines = chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0);
      expect(lines).toHaveLength(2);
      const delivered = lines.map((line) => JSON.parse(line) as { state: string });
      expect(delivered.map((alert) => alert.state)).toEqual(['firing', 'resolved']);

      expect(collector.sinks).toHaveLength(2);
      expect(collector.sinks[1]?.failed).toBe(2);
      expect(sinkErrors.length).toBeGreaterThan(0);

      await collector.close();
    } finally {
      await server.stop();
    }

    const base = { windowMs: 1000, capacity: 10, alerts: rules };
    expect(() =>
      collectorModule.createCollector({ ...base, sinks: [{ type: 'carrier-pigeon' }] }),
    ).toThrow(/carrier-pigeon/);
    expect(() =>
      collectorModule.createCollector({
        ...base,
        sinks: [{ type: 'webhook', url: 'ftp://127.0.0.1/alerts' }],
      }),
    ).toThrow(/webhook/);
    expect(() =>
      collectorModule.createCollector({
        ...base,
        sinks: [{ type: 'webhook', url: 'http://127.0.0.1/alerts', timeoutMs: 0 }],
      }),
    ).toThrow(/webhook/);
  }, 15_000);
});
