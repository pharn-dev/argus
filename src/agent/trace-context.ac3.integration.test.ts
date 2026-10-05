import { request as httpRequest, createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, describe, expect, it } from 'vitest';

type TraceSpan = {
  traceId: string;
  method: string;
  path: string;
  statusCode: number;
  startTimeMs: number;
  durationNs: number;
};

type SpanDrain = { spans: TraceSpan[]; dropped: number };

type HttpTracingApi = {
  currentTraceId(): string | undefined;
  enable(options?: { spanBufferSize?: number }): void;
  disable(): void;
  drainSpans(): SpanDrain;
};

type Sent = { method: string; requestPath: string; path: string; status: number; body: string };

const SPAN_BUFFER_SIZE = 3;

let server: Server | undefined;
let api: HttpTracingApi | undefined;

async function loadApi(): Promise<HttpTracingApi> {
  const mod = (await import('./index.js')) as unknown as Partial<HttpTracingApi>;
  if (
    typeof mod.currentTraceId !== 'function' ||
    typeof mod.enable !== 'function' ||
    typeof mod.disable !== 'function' ||
    typeof mod.drainSpans !== 'function'
  ) {
    throw new Error(
      'currentTraceId / enable / disable / drainSpans are not exported from src/agent/index.ts',
    );
  }
  return mod as HttpTracingApi;
}

function send(port: number, method: string, requestPath: string): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: requestPath, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          method,
          requestPath,
          path: requestPath.split('?')[0] ?? requestPath,
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Lets the server-side response finish be recorded after the client has read the body. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await delay(25);
}

afterAll(async () => {
  api?.disable();
  const s = server;
  if (s) {
    await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
  }
});

describe('agent HTTP span recording — AC-3', () => {
  it('AC-3: records one integer-timed span per request into a bounded drop-oldest buffer; enable is idempotent and disable stops tracing', async () => {
    const loaded = await loadApi();
    api = loaded;

    const s = createServer((req, res) => {
      res.statusCode = req.url?.startsWith('/missing') ? 404 : 200;
      res.end(String(loaded.currentTraceId()));
    });
    server = s;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    const { port } = s.address() as AddressInfo;

    loaded.enable({ spanBufferSize: SPAN_BUFFER_SIZE });
    loaded.drainSpans();

    const startedAt = Date.now();
    const sent: Sent[] = [];
    sent.push(await send(port, 'GET', '/first'));
    sent.push(await send(port, 'POST', '/second'));
    sent.push(await send(port, 'GET', '/missing'));
    sent.push(await send(port, 'GET', '/search?q=argus&page=2'));
    sent.push(await send(port, 'DELETE', '/last'));
    await settle();
    const finishedAt = Date.now();

    const first = loaded.drainSpans();
    const kept = sent.slice(-SPAN_BUFFER_SIZE);
    expect(first.dropped).toBe(sent.length - SPAN_BUFFER_SIZE);
    expect(first.spans).toHaveLength(SPAN_BUFFER_SIZE);

    for (const [i, span] of first.spans.entries()) {
      const expected = kept[i];
      expect(expected).toBeDefined();
      if (!expected) continue;
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.traceId).toBe(expected.body);
      expect(span.method).toBe(expected.method);
      expect(span.path).toBe(expected.path);
      expect(span.path).not.toContain('?');
      expect(span.statusCode).toBe(expected.status);
      expect(Number.isInteger(span.startTimeMs)).toBe(true);
      expect(span.startTimeMs).toBeGreaterThanOrEqual(startedAt);
      expect(span.startTimeMs).toBeLessThanOrEqual(finishedAt);
      expect(Number.isInteger(span.durationNs)).toBe(true);
      expect(span.durationNs).toBeGreaterThanOrEqual(0);
    }
    expect(first.spans.map((span) => span.statusCode)).toContain(404);
    expect(first.spans.map((span) => span.path)).toContain('/search');

    loaded.enable();
    const again = await send(port, 'GET', '/again');
    await settle();
    const second = loaded.drainSpans();
    expect(second.spans).toHaveLength(1);
    expect(second.spans[0]?.traceId).toBe(again.body);
    expect(second.spans[0]?.path).toBe('/again');

    loaded.disable();
    const afterDisable = await send(port, 'GET', '/after-disable');
    await settle();
    expect(afterDisable.body).toBe('undefined');
    const third = loaded.drainSpans();
    expect(third.spans).toHaveLength(0);
  });
});
