import { once } from 'node:events';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, get, type IncomingMessage } from 'node:http';
import { createServer as createNetServer, connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough, Transform, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackpressureProbe, type BackpressureProbe } from './backpressure-probe.js';

// Regression tests for F-03 (production-readiness audit): every stream kind that can stall is
// observed. One stall (write() returns false, then 'drain') is exactly one backpressure event.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function enabledProbe(): BackpressureProbe {
  const probe = createBackpressureProbe();
  probe.enable();
  cleanups.push(() => probe.disable());
  return probe;
}

type WritableLike = { write(chunk: string | Buffer): boolean };

/** Write until write() returns false; fails the test if it never does. */
function fillUntilFalse(stream: WritableLike, chunk: string | Buffer, limit = 10_000): void {
  for (let i = 0; i < limit; i += 1) {
    if (!stream.write(chunk)) {
      return;
    }
  }
  throw new Error('write() never returned false');
}

describe('backpressure probe — stream kinds (F-03)', () => {
  it('Writable: stall then drain is one event', async () => {
    const stream = new Writable({
      highWaterMark: 1,
      write(_chunk: Buffer, _encoding, callback) {
        setTimeout(() => callback(), 2);
      },
    });
    const probe = enabledProbe();
    fillUntilFalse(stream, 'x');
    await once(stream, 'drain');
    expect(probe.sample().events).toBe(1);
  });

  it('Duplex: stall then drain is one event', async () => {
    const stream = new Duplex({
      highWaterMark: 1,
      write(_chunk: Buffer, _encoding, callback) {
        setTimeout(() => callback(), 2);
      },
      read() {},
    });
    cleanups.push(() => stream.destroy());
    const probe = enabledProbe();
    fillUntilFalse(stream, 'x');
    await once(stream, 'drain');
    expect(probe.sample().events).toBe(1);
  });

  it('PassThrough: stall then drain is one event', async () => {
    const stream = new PassThrough({ highWaterMark: 1 });
    cleanups.push(() => stream.destroy());
    const probe = enabledProbe();
    fillUntilFalse(stream, 'x');
    const drained = once(stream, 'drain');
    stream.resume();
    await drained;
    expect(probe.sample().events).toBe(1);
  });

  it('Transform: stall then drain is one event', async () => {
    const stream = new Transform({
      highWaterMark: 1,
      transform(chunk: Buffer, _encoding, callback) {
        callback(null, chunk);
      },
    });
    cleanups.push(() => stream.destroy());
    const probe = enabledProbe();
    fillUntilFalse(stream, 'x');
    const drained = once(stream, 'drain');
    stream.resume();
    await drained;
    expect(probe.sample().events).toBe(1);
  });

  it('fs.WriteStream: stall then drain is one event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'argus-bp-kinds-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const stream = createWriteStream(join(dir, 'out.txt'), { highWaterMark: 1 });
    const probe = enabledProbe();
    fillUntilFalse(stream, 'xx');
    await once(stream, 'drain');
    const reading = probe.sample();
    stream.end();
    await once(stream, 'close');
    expect(reading.events).toBe(1);
  });

  it('net.Socket (a real socket pair): stall then drain is one event', async () => {
    const server = createNetServer();
    cleanups.push(() => server.close());
    const accepted = once(server, 'connection') as Promise<[Socket]>;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const client = connect(port, '127.0.0.1');
    cleanups.push(() => client.destroy());
    await once(client, 'connect');
    const [peer] = await accepted;
    cleanups.push(() => peer.destroy());
    // The peer does not read, so the kernel buffers fill and the client's write() returns false.
    peer.pause();

    const probe = enabledProbe();
    fillUntilFalse(client, Buffer.alloc(1 << 20));
    const drained = once(client, 'drain');
    peer.resume();
    await drained;
    expect(probe.sample().events).toBe(1);
  });

  it('http.ServerResponse: stall then drain is one event, attributed to the handler, not double-counted on the socket', async () => {
    let probe: BackpressureProbe | undefined;
    let markStalled: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      markStalled = resolve;
    });
    const server = createHttpServer((_req, res) => {
      void (async () => {
        probe = enabledProbe();
        fillUntilFalse(res, Buffer.alloc(1 << 20, 97));
        markStalled();
        await once(res, 'drain');
        res.end();
      })();
    });
    cleanups.push(() => server.close());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      get({ host: '127.0.0.1', port, path: '/', agent: false }, resolve).on('error', reject);
    });
    // Not consumed until the server has stalled.
    await stalled;
    response.resume();
    await once(response, 'end');

    expect(probe).toBeDefined();
    const reading = probe!.sample();
    expect(reading.events).toBe(1);
    expect(reading.hotspots).toHaveLength(1);
    expect(reading.hotspots[0]!.site).toContain('backpressure-stream-kinds.test.ts');
  });
});
