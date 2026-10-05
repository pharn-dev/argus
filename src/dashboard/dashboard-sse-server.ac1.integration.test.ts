import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type AlertRuleInput = {
  id: string;
  metric: string;
  comparison: string;
  threshold: number;
  forWindows?: number;
};

type CollectorUnderTest = {
  readonly windows: { snapshot(): unknown[] };
  readonly alerts: { snapshot(): unknown[] };
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: {
    windowMs: number;
    capacity: number;
    alerts?: readonly AlertRuleInput[];
  }) => CollectorUnderTest;
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

/** Parses every complete SSE block of the text into events and comment lines. */
function parseSse(raw: string): { events: SseEvent[]; comments: string[] } {
  const text = raw.replace(/\r\n/g, '\n');
  const blocks = text.split('\n\n');
  blocks.pop();
  const events: SseEvent[] = [];
  const comments: string[] = [];
  for (const block of blocks) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        comments.push(line);
      } else if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        data.push(line.slice('data:'.length).replace(/^ /, ''));
      }
    }
    if (event !== undefined) {
      events.push({ event, data });
    }
  }
  return { events, comments };
}

/** Polls the predicate until it holds, or fails after the timeout. */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const rules: AlertRuleInput[] = [
  { id: 'loop-max', metric: 'eventLoop.max', comparison: '>', threshold: 100 },
];

describe('dashboard SSE server — AC-1', () => {
  it('AC-1: GET /events replays the existing window and alert, then streams new ones, with heartbeat comments', async () => {
    const collectorModule = (await import('../collector/index.js')) as unknown as CollectorModule;
    const dashboardModule = (await import('./index.js')) as unknown as DashboardModule;

    const collector = collectorModule.createCollector({
      windowMs: 1000,
      capacity: 50,
      alerts: rules,
    });
    // Window 0 fires the rule, window 1000 resolves it: the collector holds windows and alerts.
    await collector.consume(Readable.from([makeSample(100, 500), makeSample(1100, 50)]));
    const preWindows = collector.windows.snapshot();
    const preAlerts = collector.alerts.snapshot();
    expect(preWindows.length).toBeGreaterThanOrEqual(1);
    expect(preAlerts.length).toBeGreaterThanOrEqual(1);

    let server: DashboardServerUnderTest | undefined;
    let request: ClientRequest | undefined;
    try {
      server = await dashboardModule.createDashboardServer({
        collector,
        host: '127.0.0.1',
        port: 0,
        heartbeatMs: 50,
      });
      const port = server.port;

      let body = '';
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        request = get(`http://127.0.0.1:${port}/events`, resolve);
        request.on('error', reject);
      });
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });

      expect(response.statusCode).toBe(200);
      expect(String(response.headers['content-type'] ?? '')).toMatch(/^text\/event-stream/);

      const replayCount = preWindows.length + preAlerts.length;
      await waitFor(
        () => parseSse(body).events.length >= replayCount,
        5_000,
        'the replay of the existing windows and alerts',
      );

      // One more window (2000) and one more alert (the rule fires again).
      await collector.consume(Readable.from([makeSample(2100, 500)]));
      const postWindows = collector.windows.snapshot();
      const postAlerts = collector.alerts.snapshot();
      const newWindows = postWindows.slice(preWindows.length);
      const newAlerts = postAlerts.slice(preAlerts.length);
      expect(newWindows).toHaveLength(1);
      expect(newAlerts).toHaveLength(1);

      await waitFor(
        () => parseSse(body).events.length >= replayCount + 2,
        5_000,
        'the new window and alert events',
      );

      // Keep reading past more than one heartbeat interval.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const { events, comments } = parseSse(body);
      for (const event of events) {
        expect(event.data).toHaveLength(1);
      }
      const parsed = events.map((event) => ({
        event: event.event,
        data: JSON.parse(event.data[0] ?? '') as unknown,
      }));

      expect(parsed.slice(0, replayCount)).toEqual([
        ...preWindows.map((window) => ({ event: 'window', data: window })),
        ...preAlerts.map((alert) => ({ event: 'alert', data: alert })),
      ]);
      expect(parsed.slice(replayCount)).toEqual([
        { event: 'window', data: newWindows[0] },
        { event: 'alert', data: newAlerts[0] },
      ]);
      expect(comments.length).toBeGreaterThanOrEqual(1);
      expect(
        body
          .replace(/\r\n/g, '\n')
          .split('\n')
          .some((line) => line.startsWith(':')),
      ).toBe(true);
    } finally {
      request?.destroy();
      await server?.close();
    }
  }, 20_000);
});
