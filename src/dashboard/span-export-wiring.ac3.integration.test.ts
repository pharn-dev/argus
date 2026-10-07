import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';

type SpanRecord = {
  type: 'span';
  traceId: string;
  spanId: string;
  name: string;
  method: string;
  path: string;
  statusCode: number;
  startTimeMs: number;
  durationNs: number;
};

type CollectorUnderTest = {
  readonly windows: { snapshot(): unknown[] };
  readonly alerts: { snapshot(): unknown[] };
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: { windowMs: number; capacity: number }) => CollectorUnderTest;
};

type DashboardServerUnderTest = {
  readonly port: number;
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
  }) => Promise<DashboardServerUnderTest>;
};

type SseEvent = { event: string; data: string[] };

function makeSpan(n: number, path: string, statusCode: number): SpanRecord {
  return {
    type: 'span',
    traceId: `${String(n).padStart(2, '0')}${'c'.repeat(30)}`,
    spanId: `${String(n).padStart(2, '0')}${'d'.repeat(14)}`,
    name: `GET ${path}`,
    method: 'GET',
    path,
    statusCode,
    startTimeMs: 1_700_000_000_000 + n,
    durationNs: 2_000 * n,
  };
}

/** Parses every complete SSE block of the text into events (comment lines are skipped). */
function parseSse(raw: string): SseEvent[] {
  const blocks = raw.split('\r\n').join('\n').split('\n\n');
  blocks.pop();
  const events: SseEvent[] = [];
  for (const block of blocks) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        const value = line.slice('data:'.length);
        data.push(value.startsWith(' ') ? value.slice(1) : value);
      }
    }
    if (event !== undefined) {
      events.push({ event, data });
    }
  }
  return events;
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

/** Opens a GET and resolves on its response headers; the body is collected as it arrives. */
function open(
  port: number,
  headers: Record<string, string>,
): Promise<{ request: ClientRequest; response: IncomingMessage; body: () => string }> {
  return new Promise((resolve, reject) => {
    let body = '';
    const request = httpRequest(
      { host: '127.0.0.1', port, path: '/events', method: 'GET', headers },
      (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        resolve({ request, response, body: () => body });
      },
    );
    request.on('error', reject);
    request.setTimeout(10_000, () => {
      request.destroy(new Error('GET /events timed out'));
    });
    request.end();
  });
}

let server: DashboardServerUnderTest | undefined;
const requests: ClientRequest[] = [];

afterAll(async () => {
  for (const request of requests) {
    request.destroy();
  }
  await server?.close();
});

describe('dashboard span events — AC-3', () => {
  it('AC-3: an authorized SSE client receives one span event per recorded span, in order; a tokenless client gets 401 and no span event', async () => {
    const collectorModule = (await import('../collector/index.js')) as unknown as CollectorModule;
    const dashboardModule = (await import('./index.js')) as unknown as DashboardModule;

    const collector = collectorModule.createCollector({ windowMs: 1000, capacity: 10 });
    server = await dashboardModule.createDashboardServer({
      collector,
      host: '127.0.0.1',
      port: 0,
      token: 's3cret',
      heartbeatMs: 1_000,
    });
    const port = server.port;

    const authorized = await open(port, { authorization: 'Bearer s3cret' });
    requests.push(authorized.request);
    expect(authorized.response.statusCode).toBe(200);
    expect(String(authorized.response.headers['content-type'] ?? '')).toMatch(
      /^text\/event-stream/,
    );

    const tokenless = await open(port, {});
    requests.push(tokenless.request);
    expect(tokenless.response.statusCode).toBe(401);
    await new Promise<void>((resolve, reject) => {
      if (tokenless.response.complete) {
        resolve();
        return;
      }
      tokenless.response.once('end', resolve);
      tokenless.response.once('error', reject);
    });

    const spans = [makeSpan(1, '/a', 200), makeSpan(2, '/b', 404), makeSpan(3, '/c', 500)];
    await collector.consume(Readable.from(spans));

    const spanEvents = (): SseEvent[] =>
      parseSse(authorized.body()).filter((event) => event.event === 'span');
    await waitFor(() => spanEvents().length >= spans.length, 5_000, 'three span events');
    // Read a little longer so an extra span event would show up.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const received = spanEvents();
    expect(received).toHaveLength(spans.length);
    for (const event of received) {
      expect(event.data).toHaveLength(1);
    }
    expect(received.map((event) => JSON.parse(event.data[0] ?? '') as unknown)).toEqual(spans);

    expect(parseSse(tokenless.body()).filter((event) => event.event === 'span')).toHaveLength(0);
    expect(tokenless.body()).not.toContain('event: span');
  }, 20_000);
});
