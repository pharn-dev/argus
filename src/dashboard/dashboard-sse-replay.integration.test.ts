import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  createCollector,
  DEFAULT_SPAN_CAPACITY,
  type AggregatedWindow,
  type Alert,
  type SpanRecord,
} from '../collector/index.js';
import { createDashboardServer, type DashboardServer } from './index.js';

const CAPACITY = 300;

function makeWindow(i: number): AggregatedWindow {
  return {
    start: i * 1000,
    end: (i + 1) * 1000,
    count: 1,
    late: 0,
    eventLoop: { max: i, p99: i, mean: i },
    memory: { heapUsedLast: i, heapUsedMax: i, rssLast: i, rssMax: i },
    gc: { count: 0, totalPause: 0, maxPause: 0 },
    backpressure: { events: 0, totalStall: 0, maxStall: 0 },
  };
}

function makeAlert(i: number): Alert {
  return {
    ruleId: `rule-${i}`,
    metric: 'eventLoop.max',
    comparison: '>',
    threshold: 100,
    observed: 200 + i,
    windowStart: i * 1000,
    windowEnd: (i + 1) * 1000,
    state: i % 2 === 0 ? 'firing' : 'resolved',
  };
}

function makeSpan(i: number): SpanRecord {
  return {
    type: 'span',
    traceId: i.toString(16).padStart(32, '0'),
    spanId: i.toString(16).padStart(16, '0'),
    name: 'GET /x',
    method: 'GET',
    path: '/x',
    statusCode: 200,
    startTimeMs: i,
    durationNs: 1_000_000,
  };
}

function parseEvents(raw: string): { event: string; data: unknown }[] {
  const blocks = raw.split('\n\n');
  blocks.pop();
  const events: { event: string; data: unknown }[] = [];
  for (const block of blocks) {
    let event: string | undefined;
    let data: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        event = line.slice('event: '.length);
      } else if (line.startsWith('data: ')) {
        data = line.slice('data: '.length);
      }
    }
    if (event !== undefined && data !== undefined) {
      events.push({ event, data: JSON.parse(data) as unknown });
    }
  }
  return events;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('dashboard SSE initial replay', () => {
  it('delivers every buffered alert, window and span to a new client, alerts first, with no drops', async () => {
    const collector = createCollector({ windowMs: 1000, capacity: CAPACITY });
    // Fill every ring buffer to capacity: together they exceed the default 1000-event live queue.
    for (let i = 0; i < CAPACITY; i += 1) {
      collector.windows.push(makeWindow(i));
      collector.alerts.push(makeAlert(i));
    }
    for (let i = 0; i < DEFAULT_SPAN_CAPACITY; i += 1) {
      collector.spans.push(makeSpan(i));
    }
    const alerts = collector.alerts.snapshot();
    const windows = collector.windows.snapshot();
    const spans = collector.spans.snapshot();
    expect([alerts.length, windows.length, spans.length]).toEqual([
      CAPACITY,
      CAPACITY,
      DEFAULT_SPAN_CAPACITY,
    ]);
    const total = alerts.length + windows.length + spans.length;

    let server: DashboardServer | undefined;
    let request: ClientRequest | undefined;
    try {
      server = await createDashboardServer({ collector, host: '127.0.0.1', port: 0 });
      const port = server.port;
      let body = '';
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        request = get(`http://127.0.0.1:${port}/events`, resolve);
        request.on('error', reject);
      });
      expect(response.statusCode).toBe(200);
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });

      await waitFor(() => parseEvents(body).length >= total, 4_000, 'the full replay');

      expect(server.droppedEvents).toBe(0);
      expect(parseEvents(body)).toEqual([
        ...alerts.map((data) => ({ event: 'alert', data })),
        ...windows.map((data) => ({ event: 'window', data })),
        ...spans.map((data) => ({ event: 'span', data })),
      ]);
    } finally {
      request?.destroy();
      await server?.close();
      await collector.close();
    }
  });
});
