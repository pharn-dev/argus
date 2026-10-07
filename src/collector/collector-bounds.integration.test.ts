import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Alert } from './alert-evaluator.js';
import type { AlertSink } from './alert-sink.js';
import { createCollector } from './collector.js';
import { createFileSink } from './file-sink.js';
import { createSinkDispatcher } from './sink-dispatcher.js';
import type { AggregatedWindow } from './window.js';
import { createWindowStore } from './window-store.js';
import { createWebhookSink } from './webhook-sink.js';

// Generous for a loaded CI runner, far below what the unbounded behaviour took (retries × timeout).
const EPSILON_MS = 400;

const ALERT: Alert = {
  ruleId: 'lag',
  metric: 'eventLoop.p99',
  comparison: 'above',
  threshold: 1,
  observed: 2,
  windowStart: 0,
  windowEnd: 1000,
  state: 'firing',
} as unknown as Alert;

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
    url: `http://127.0.0.1:${port}/hook`,
    requests: () => requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A server that reads each request and never answers it. */
function hanging(): Promise<Started> {
  return listen((request) => {
    request.resume();
  });
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('webhook sink transport bounds (F-06)', () => {
  it.each([302, 307])(
    'treats a %i redirect as a failed delivery and never contacts the redirect target',
    async (status) => {
      const target = await listen((request, response) => {
        request.resume();
        response.end('ok');
      });
      const origin = await listen((request, response) => {
        request.resume();
        response.writeHead(status, { location: target.url });
        response.end();
      });
      try {
        const errors: Error[] = [];
        const sink = createWebhookSink({
          url: origin.url,
          retries: 2,
          backoffMs: 1,
          onError: (error) => errors.push(error),
        });
        await sink.send(ALERT);
        await sink.close();
        expect(target.requests()).toBe(0);
        expect(origin.requests()).toBe(1); // a redirect is not retried
        expect(sink.failed).toBe(1);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.message).toContain(`redirect (status ${status}) not followed`);
        expect(errors[0]?.message).not.toContain('/hook');
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
      const sink = createWebhookSink({ url: server.url, onError: (error) => errors.push(error) });
      await sink.send(ALERT);
      const finished = await responseClosed;
      expect(finished).toBe(false); // the client cancelled the body: the connection closed early
      expect(written).toBeLessThan(total / 2);
      expect(sink.failed).toBe(0);
      expect(errors).toHaveLength(0);
      await sink.close();
    } finally {
      await server.stop();
    }
  }, 20_000);
});

describe('webhook sink and dispatcher bounded close (F-08)', () => {
  it('close() aborts hanging deliveries after closeTimeoutMs and counts them as failed', async () => {
    const server = await hanging();
    try {
      const errors: Error[] = [];
      const sink = createWebhookSink({
        url: server.url,
        timeoutMs: 10_000,
        closeTimeoutMs: 200,
        retries: 2,
        onError: (error) => errors.push(error),
      });
      const deliveries = Array.from({ length: 5 }, () => sink.send(ALERT));
      await until(() => server.requests() === 5);
      const started = Date.now();
      await sink.close();
      const elapsed = Date.now() - started;
      await Promise.all(deliveries);
      expect(elapsed).toBeLessThan(200 + EPSILON_MS);
      expect(sink.failed).toBe(5);
      expect(errors).toHaveLength(5);
      expect(errors[0]?.message).toContain('aborted');
      expect(server.requests()).toBe(5); // no retry after close
    } finally {
      await server.stop();
    }
  }, 15_000);

  it('close() with the default closeTimeoutMs takes at most one request timeout and stops retries', async () => {
    const server = await hanging();
    try {
      const sink = createWebhookSink({
        url: server.url,
        timeoutMs: 400,
        retries: 2,
        backoffMs: 100,
        onError: () => undefined,
      });
      for (let i = 0; i < 5; i += 1) void sink.send(ALERT);
      await until(() => server.requests() === 5);
      const started = Date.now();
      await sink.close();
      expect(Date.now() - started).toBeLessThan(400 + EPSILON_MS);
      expect(sink.failed).toBe(5);
      expect(server.requests()).toBe(5);
    } finally {
      await server.stop();
    }
  }, 15_000);

  it('dispatcher close() closes sinks without first waiting for every delivery', async () => {
    const server = await hanging();
    try {
      const sink = createWebhookSink({
        url: server.url,
        timeoutMs: 10_000,
        closeTimeoutMs: 200,
        onError: () => undefined,
      });
      const dispatcher = createSinkDispatcher([sink], () => undefined);
      for (let i = 0; i < 3; i += 1) dispatcher.deliver(ALERT);
      await until(() => server.requests() === 3);
      const started = Date.now();
      await dispatcher.close();
      expect(Date.now() - started).toBeLessThan(200 + EPSILON_MS);
      expect(sink.failed).toBe(3);
    } finally {
      await server.stop();
    }
  }, 15_000);

  it('dispatcher close() still delivers alerts handed over just before it', async () => {
    const sent: Alert[] = [];
    let closed = false;
    const sink: AlertSink = {
      type: 'memory',
      name: undefined,
      failed: 0,
      dropped: 0,
      send(alert) {
        if (!closed) sent.push(alert);
        return Promise.resolve();
      },
      close() {
        closed = true;
        return Promise.resolve();
      },
    };
    const dispatcher = createSinkDispatcher([sink]);
    dispatcher.deliver(ALERT);
    await dispatcher.close();
    expect(sent).toHaveLength(1);
  });
});

describe('window store latch and file modes (F-21, F-14)', () => {
  it('append() after close() rejects and never recreates the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-store-latch-'));
    try {
      const path = join(dir, 'windows.ndjson');
      const store = createWindowStore({ path, maxBytes: 1_000_000, capacity: 4 });
      await store.append(makeWindow(0));
      await store.close();
      await rm(path);
      await expect(store.append(makeWindow(1000))).rejects.toThrow(/closed/);
      await store.release();
      expect(await exists(path)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('release() still allows a later append (sequential consume)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-store-release-'));
    try {
      const path = join(dir, 'windows.ndjson');
      const store = createWindowStore({ path, maxBytes: 1_000_000, capacity: 4 });
      await store.append(makeWindow(0));
      await store.release();
      await store.append(makeWindow(1000));
      await store.close();
      expect(await exists(path)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a consume() after collector.close() does not recreate the persistence file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-collector-latch-'));
    try {
      const path = join(dir, 'windows.ndjson');
      const collector = createCollector({
        windowMs: 1000,
        capacity: 4,
        persist: { path, maxBytes: 1_000_000 },
      });
      await collector.consume(Readable.from([makeSample(100), makeSample(1100)]));
      expect(await exists(path)).toBe(true);
      await collector.close();
      await rm(path);
      await expect(
        collector.consume(Readable.from([makeSample(2100), makeSample(3100)])),
      ).rejects.toThrow(/closed/);
      expect(await exists(path)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'creates the persistence and file-sink files with mode 0600',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'argus-modes-'));
      try {
        const storePath = join(dir, 'windows.ndjson');
        const store = createWindowStore({ path: storePath, maxBytes: 300, capacity: 2 });
        await store.append(makeWindow(0));
        expect((await stat(storePath)).mode & 0o777).toBe(0o600);
        // Past maxBytes the file is rewritten through a temp file: still 0600.
        for (let i = 1; i < 6; i += 1) await store.append(makeWindow(i * 1000));
        expect(store.bytes).toBeLessThanOrEqual(600);
        expect((await stat(storePath)).mode & 0o777).toBe(0o600);
        await store.close();

        const sinkPath = join(dir, 'alerts.ndjson');
        const sink = createFileSink({ path: sinkPath });
        await sink.send(ALERT);
        await sink.close();
        expect((await stat(sinkPath)).mode & 0o777).toBe(0o600);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'leaves the mode of a file the user created alone, including across compaction',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'argus-modes-existing-'));
      try {
        const storePath = join(dir, 'windows.ndjson');
        await writeFile(storePath, '');
        await chmod(storePath, 0o640);
        const store = createWindowStore({ path: storePath, maxBytes: 300, capacity: 2 });
        for (let i = 0; i < 6; i += 1) await store.append(makeWindow(i * 1000));
        await store.close();
        expect((await stat(storePath)).mode & 0o777).toBe(0o640);

        const sinkPath = join(dir, 'alerts.ndjson');
        await writeFile(sinkPath, '');
        await chmod(sinkPath, 0o640);
        const sink = createFileSink({ path: sinkPath });
        await sink.send(ALERT);
        await sink.close();
        expect((await stat(sinkPath)).mode & 0o777).toBe(0o640);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
