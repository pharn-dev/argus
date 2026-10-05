import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type WindowLike = { start: number };

type CollectorUnderTest = {
  readonly windows: { snapshot(): WindowLike[] };
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

type SseEvent = { event: string; data: string[] };

const WINDOW_MS = 1000;
const CAPACITY = 20;
const BATCH = 40;
const MAX_WINDOWS = 200_000;

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

/** Incrementally parses SSE text into complete events. */
function createSseParser(): { push(chunk: string): void; readonly events: SseEvent[] } {
  let pending = '';
  const events: SseEvent[] = [];
  return {
    events,
    push(chunk: string) {
      pending += chunk.replace(/\r\n/g, '\n');
      let boundary = pending.indexOf('\n\n');
      while (boundary !== -1) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        let event: string | undefined;
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) {
            event = line.slice('event:'.length).trim();
          } else if (line.startsWith('data:')) {
            data.push(line.slice('data:'.length).replace(/^ /, ''));
          }
        }
        if (event !== undefined) {
          events.push({ event, data });
        }
        boundary = pending.indexOf('\n\n');
      }
    },
  };
}

/** Polls the predicate until it holds, or fails after the timeout. */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

describe('dashboard SSE server — AC-3', () => {
  it('AC-3: a stalled client is bounded (dropped or disconnected) while a reading client gets every window, and close() ends everything', async () => {
    const collectorModule = (await import('../collector/index.js')) as unknown as CollectorModule;
    const dashboardModule = (await import('./index.js')) as unknown as DashboardModule;

    const collector = collectorModule.createCollector({ windowMs: WINDOW_MS, capacity: CAPACITY });

    let server: DashboardServerUnderTest | undefined;
    let stalled: Socket | undefined;
    let reader: ClientRequest | undefined;
    try {
      server = await dashboardModule.createDashboardServer({
        collector,
        host: '127.0.0.1',
        port: 0,
        heartbeatMs: 60_000,
        maxBufferedEvents: 4,
      });
      const live = server;
      const port = live.port;

      // The stalled client: sends the request, then never reads from its socket.
      let stalledClosed = false;
      const stalledSocket = connect({ host: '127.0.0.1', port });
      stalled = stalledSocket;
      stalledSocket.on('error', () => {
        stalledClosed = true;
      });
      stalledSocket.on('close', () => {
        stalledClosed = true;
      });
      await new Promise<void>((resolve, reject) => {
        stalledSocket.once('connect', () => {
          stalledSocket.write(
            `GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`,
          );
          stalledSocket.pause();
          resolve();
        });
        stalledSocket.once('error', reject);
      });

      // The reading client.
      const parser = createSseParser();
      let readerClosed = false;
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        reader = get(`http://127.0.0.1:${port}/events`, resolve);
        reader.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ECONNRESET') {
            reject(error);
          }
        });
      });
      expect(response.statusCode).toBe(200);
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => parser.push(chunk));
      response.on('error', () => {
        readerClosed = true;
      });
      response.on('close', () => {
        readerClosed = true;
      });

      await waitFor(() => live.clientCount === 2, 5_000, 'both SSE clients to be connected');

      const readerWindows = (): SseEvent[] => parser.events.filter((e) => e.event === 'window');

      let produced = 0;
      while (live.droppedEvents <= 0 && !stalledClosed) {
        if (produced >= MAX_WINDOWS) {
          throw new Error(`no backpressure after ${produced} windows`);
        }
        const samples: Record<string, unknown>[] = [];
        for (let i = 0; i < BATCH; i += 1) {
          samples.push(makeSample((produced + i) * WINDOW_MS + 100));
        }
        await collector.consume(Readable.from(samples));
        produced += BATCH;
        await waitFor(
          () => readerWindows().length >= produced,
          10_000,
          `the reading client to receive ${produced} windows`,
        );
      }

      const dropped = live.droppedEvents;
      expect(stalledClosed || (Number.isInteger(dropped) && dropped > 0)).toBe(true);

      // The reading client got every window, in order, each on one data line.
      const windows = readerWindows();
      expect(windows).toHaveLength(produced);
      for (const event of windows) {
        expect(event.data).toHaveLength(1);
      }
      const payloads = windows.map((event) => JSON.parse(event.data[0] ?? '') as WindowLike);
      expect(payloads.map((window) => window.start)).toEqual(
        Array.from({ length: produced }, (_, index) => index * WINDOW_MS),
      );

      // The collector ring holds the newest windows, as the reading client saw them.
      const snapshot = collector.windows.snapshot();
      expect(snapshot).toHaveLength(CAPACITY);
      expect(snapshot).toEqual(payloads.slice(-CAPACITY));

      await expect(live.close()).resolves.toBeUndefined();

      await waitFor(() => readerClosed, 5_000, 'the reading SSE response to end');
      stalledSocket.resume();
      await waitFor(() => stalledClosed, 5_000, 'the stalled SSE connection to end');
      expect(await probeConnect(port)).toBe('ECONNREFUSED');
    } finally {
      reader?.destroy();
      stalled?.destroy();
      await server?.close();
    }
  }, 120_000);
});
