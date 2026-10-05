import { request as httpRequest, createServer } from 'node:http';
import type { OutgoingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, describe, expect, it } from 'vitest';

type HttpTracingApi = {
  currentTraceId(): string | undefined;
  enable(options?: { spanBufferSize?: number }): void;
  disable(): void;
};

const TRACE_ID = /^[0-9a-f]{32}$/;
const CONCURRENT_REQUESTS = 12;
const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const VALID_TRACEPARENT = `00-${VALID_TRACE_ID}-00f067aa0ba902b7-01`;
const INVALID_TRACEPARENT = 'not-a-valid-traceparent-value';

let server: Server | undefined;
let api: HttpTracingApi | undefined;

async function loadApi(): Promise<HttpTracingApi> {
  const mod = (await import('./index.js')) as unknown as Partial<HttpTracingApi>;
  if (
    typeof mod.currentTraceId !== 'function' ||
    typeof mod.enable !== 'function' ||
    typeof mod.disable !== 'function'
  ) {
    throw new Error('currentTraceId / enable / disable are not exported from src/agent/index.ts');
  }
  return mod as HttpTracingApi;
}

function get(port: number, headers: OutgoingHttpHeaders = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

afterAll(async () => {
  api?.disable();
  const s = server;
  if (s) {
    await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
  }
});

describe('agent HTTP tracing — AC-2', () => {
  it('AC-2: concurrent requests each see their own trace id; a valid traceparent is adopted and an invalid one replaced', async () => {
    const loaded = await loadApi();
    api = loaded;
    loaded.enable();

    const s = createServer((_req, res) => {
      void (async () => {
        await delay(10);
        res.end(String(loaded.currentTraceId()));
      })();
    });
    server = s;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    const { port } = s.address() as AddressInfo;

    const plainCount = CONCURRENT_REQUESTS - 2;
    const [validBody, invalidBody, ...plainBodies] = await Promise.all([
      get(port, { traceparent: VALID_TRACEPARENT }),
      get(port, { traceparent: INVALID_TRACEPARENT }),
      ...Array.from({ length: plainCount }, () => get(port)),
    ]);

    const bodies = [validBody, invalidBody, ...plainBodies];
    expect(bodies).toHaveLength(CONCURRENT_REQUESTS);
    for (const body of bodies) expect(body).toMatch(TRACE_ID);
    expect(new Set(bodies).size).toBe(CONCURRENT_REQUESTS);

    expect(validBody).toBe(VALID_TRACE_ID);
    expect(invalidBody).not.toBe(INVALID_TRACEPARENT);
    expect(invalidBody).toMatch(TRACE_ID);
  });
});
