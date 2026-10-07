import { once } from 'node:events';
import { createServer, get, OutgoingMessage, Server as HttpServer } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { Duplex, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Regression tests for F-01, F-13 and F-22 (production-readiness audit): Argus must never leave a
// prototype method that throws, and never remove a wrapper a third party installed after it.

type Sample = { events: number; hotspots: { site: string }[] };
type Probe = { enable(): void; disable(): void; sample(): Sample };
type ProbeModule = { createBackpressureProbe(options?: { maxHotspots?: number }): Probe };
type TracingModule = {
  enable(options?: { spanBufferSize?: number }): void;
  disable(): void;
  currentTraceId(): string | undefined;
};
type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

const writeTargets = [Writable.prototype, Duplex.prototype, OutgoingMessage.prototype];
const pristineWrite = writeTargets.map((target) =>
  Object.getOwnPropertyDescriptor(target, 'write'),
);
const emitTargets = [HttpServer.prototype, HttpsServer.prototype];
const pristineEmit = emitTargets.map((target) => Object.getOwnPropertyDescriptor(target, 'emit'));
const cleanups: (() => void)[] = [];

function restoreDescriptor(target: object, key: string, own: PropertyDescriptor | undefined): void {
  if (own === undefined) {
    delete (target as Record<string, unknown>)[key];
  } else {
    Object.defineProperty(target, key, own);
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  writeTargets.forEach((target, i) => restoreDescriptor(target, 'write', pristineWrite[i]));
  emitTargets.forEach((target, i) => restoreDescriptor(target, 'emit', pristineEmit[i]));
});

/** A fresh, independent evaluation of the probe module: a second "copy" of Argus. */
async function loadProbeCopy(): Promise<ProbeModule> {
  vi.resetModules();
  return (await import('./backpressure-probe.js')) as unknown as ProbeModule;
}

async function loadTracingCopy(): Promise<TracingModule> {
  vi.resetModules();
  const tracing = (await import('./http-tracing.js')) as unknown as Omit<
    TracingModule,
    'currentTraceId'
  >;
  const context = (await import('./context.js')) as unknown as Pick<
    TracingModule,
    'currentTraceId'
  >;
  return { ...tracing, currentTraceId: context.currentTraceId };
}

function track<T extends { disable(): void }>(subject: T): T {
  cleanups.push(() => subject.disable());
  return subject;
}

/** Install a third-party wrapper on `target.write` that counts calls and delegates. */
function installForeignWrite(target: object): { calls: () => number; beneath: AnyFn } {
  const holder = target as { write: AnyFn };
  const beneath = holder.write;
  let calls = 0;
  holder.write = function foreignWrite(this: unknown, ...args: unknown[]): unknown {
    calls += 1;
    return Reflect.apply(beneath, this, args);
  };
  return { calls: () => calls, beneath };
}

function sink(Ctor: typeof Writable | typeof Duplex): { stream: Writable; received: string[] } {
  const received: string[] = [];
  const stream = new Ctor({
    write(chunk: Buffer, _encoding, callback) {
      received.push(chunk.toString());
      callback();
    },
    read() {},
  });
  return { stream, received };
}

/** A Writable with a 1-byte highWaterMark that acknowledges each chunk after a short delay. */
function slowWritable(): Writable {
  return new Writable({
    highWaterMark: 1,
    write(_chunk: Buffer, _encoding, callback) {
      setTimeout(() => callback(), 2);
    },
  });
}

async function stallOnce(stream: Writable): Promise<void> {
  let guard = 0;
  while (stream.write('x')) {
    guard += 1;
    if (guard > 1000) throw new Error('write() never returned false');
  }
  await once(stream, 'drain');
}

describe('prototype patch safety — backpressure probe write wrappers (F-01)', () => {
  it.each([
    ['Writable', Writable],
    ['Duplex', Duplex],
  ] as const)(
    'a foreign %s.prototype.write wrapper installed after enable() keeps working after disable()',
    async (_name, Ctor) => {
      const { createBackpressureProbe } = await loadProbeCopy();
      const probe = track(createBackpressureProbe());
      probe.enable();
      const foreign = installForeignWrite(Ctor.prototype);
      probe.disable();

      const { stream, received } = sink(Ctor);
      expect(() => stream.write('hello')).not.toThrow();
      expect(received).toEqual(['hello']);
      expect(foreign.calls()).toBe(1);
      expect((Ctor.prototype.write as AnyFn).name).toBe('foreignWrite');

      // Enabling again with the foreign wrapper still on top counts a stall exactly once.
      probe.enable();
      await stallOnce(slowWritable());
      expect(probe.sample().events).toBe(1);
      probe.disable();
      expect(() => sink(Ctor).stream.write('again')).not.toThrow();
    },
  );

  it('an inactive Argus wrapper that a third party restored on top is skipped by the next enable()', async () => {
    const original = Writable.prototype.write;
    const { createBackpressureProbe } = await loadProbeCopy();
    const probe = track(createBackpressureProbe());
    probe.enable();
    const foreign = installForeignWrite(Writable.prototype);
    probe.disable();
    // The third party uninstalls itself by restoring what it saw: Argus's now-inactive wrapper.
    (Writable.prototype as { write: AnyFn }).write = foreign.beneath;

    const { stream, received } = sink(Writable);
    expect(() => stream.write('a')).not.toThrow();
    expect(received).toEqual(['a']);

    probe.enable();
    await stallOnce(slowWritable());
    expect(probe.sample().events).toBe(1);
    probe.disable();
    expect(Writable.prototype.write).toBe(original);
  });

  it.each([['first-enabled disabled first'], ['first-enabled disabled last']])(
    'two module copies enabled together, %s: writes keep working and the prototypes are restored',
    async (order) => {
      const copyA = await loadProbeCopy();
      const copyB = await loadProbeCopy();
      expect(copyA.createBackpressureProbe).not.toBe(copyB.createBackpressureProbe);
      const probeA = track(copyA.createBackpressureProbe());
      const probeB = track(copyB.createBackpressureProbe());

      probeA.enable();
      const wrappedOnce = writeTargets.map((target) => (target as { write: unknown }).write);
      probeB.enable();
      // The second copy joins the first copy's wrappers instead of wrapping again.
      expect(writeTargets.map((target) => (target as { write: unknown }).write)).toEqual(
        wrappedOnce,
      );

      // Each copy's probe sees the stall exactly once.
      await stallOnce(slowWritable());
      expect(probeA.sample().events).toBe(1);
      expect(probeB.sample().events).toBe(1);

      const [first, second] = order.endsWith('first') ? [probeA, probeB] : [probeB, probeA];
      first.disable();
      expect(() => sink(Writable).stream.write('mid')).not.toThrow();
      await stallOnce(slowWritable());
      expect(second.sample().events).toBe(1);
      second.disable();

      for (const Ctor of [Writable, Duplex]) {
        const { stream, received } = sink(Ctor);
        expect(() => stream.write('after')).not.toThrow();
        expect(received).toEqual(['after']);
      }
      writeTargets.forEach((target, i) => {
        expect(Object.getOwnPropertyDescriptor(target, 'write')).toEqual(pristineWrite[i]);
      });
    },
  );

  it('an observer that throws (a stream whose once() throws) never reaches the caller of write()', async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    cleanups.push(() => process.off('warning', onWarning));

    const { createBackpressureProbe } = await loadProbeCopy();
    const probe = track(createBackpressureProbe());
    probe.enable();
    class HostileWritable extends Writable {
      override once(): this {
        throw new Error('hostile once');
      }
    }
    const stream = new HostileWritable({
      highWaterMark: 1,
      write(_chunk: Buffer, _encoding, callback) {
        setTimeout(() => callback(), 2);
      },
    });
    let result: boolean | undefined;
    expect(() => {
      result = stream.write('xx');
    }).not.toThrow();
    expect(result).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(warnings.some((w) => w.name === 'ArgusBackpressureWarning')).toBe(true);
    probe.disable();
  });
});

describe('prototype patch safety — write wrapper arity and arguments (F-22)', () => {
  it('each patched write keeps the original length and receives exactly the arguments passed', async () => {
    const lengths = writeTargets.map((target) => (target as { write: AnyFn }).write.length);
    expect(lengths).toEqual([3, 3, 3]);

    // A spy beneath Argus's wrapper records how many arguments reach the original.
    const counts: number[] = [];
    const holder = Writable.prototype as unknown as { write: AnyFn };
    const beneath = holder.write;
    const spy = function spy(this: unknown, ...args: unknown[]): unknown {
      counts.push(args.length);
      return Reflect.apply(beneath, this, args);
    };
    Object.defineProperty(spy, 'length', { value: beneath.length });
    holder.write = spy;

    const { createBackpressureProbe } = await loadProbeCopy();
    const probe = track(createBackpressureProbe());
    probe.enable();
    writeTargets.forEach((target, i) => {
      expect((target as { write: AnyFn }).write.length, `target ${i}`).toBe(lengths[i]);
    });

    const { stream, received } = sink(Writable);
    let called = false;
    stream.write('a');
    stream.write('b', 'utf8');
    stream.write('c', 'utf8', () => {
      called = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(counts).toEqual([1, 2, 3]);
    expect(received).toEqual(['a', 'b', 'c']);
    expect(called).toBe(true);
    probe.disable();
  });
});

describe('prototype patch safety — http tracing emit wrapper (F-13)', () => {
  it('a foreign Server.prototype.emit wrapper installed after enable() survives disable()', async () => {
    const tracing = track(await loadTracingCopy());
    tracing.enable();
    const beneath = HttpServer.prototype.emit as AnyFn;
    let calls = 0;
    Object.defineProperty(HttpServer.prototype, 'emit', {
      value: function foreignEmit(this: unknown, ...args: unknown[]): unknown {
        calls += 1;
        return Reflect.apply(beneath, this, args);
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
    tracing.disable();

    expect((HttpServer.prototype.emit as AnyFn).name).toBe('foreignEmit');
    const server = new HttpServer();
    let heard = 0;
    server.on('custom', () => {
      heard += 1;
    });
    expect(() => server.emit('custom')).not.toThrow();
    expect(calls).toBe(1);
    expect(heard).toBe(1);
  });

  it('enable() then disable() leaves no own emit on the server prototypes', async () => {
    const tracing = track(await loadTracingCopy());
    tracing.enable();
    expect(Object.hasOwn(HttpServer.prototype, 'emit')).toBe(true);
    expect((HttpServer.prototype.emit as AnyFn).length).toBe(1);
    tracing.disable();
    emitTargets.forEach((target, i) => {
      expect(Object.getOwnPropertyDescriptor(target, 'emit')).toEqual(pristineEmit[i]);
    });
  });

  it.each([['first-enabled disabled first'], ['first-enabled disabled last']])(
    'two module copies share one emit wrapper, both trace a request, and %s restores emit',
    async (order) => {
      const copyA = track(await loadTracingCopy());
      const copyB = track(await loadTracingCopy());
      copyA.enable();
      const wrapped = HttpServer.prototype.emit;
      copyB.enable();
      expect(HttpServer.prototype.emit).toBe(wrapped);

      const seen: (string | undefined)[] = [];
      const server = createServer((_req, res) => {
        seen.push(copyA.currentTraceId(), copyB.currentTraceId());
        res.end('ok');
      });
      cleanups.push(() => server.close());
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        get(
          {
            host: '127.0.0.1',
            port,
            path: '/',
            agent: false,
            headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
          },
          resolve,
        ).on('error', reject);
      });
      response.resume();
      await once(response, 'end');
      expect(seen).toEqual([traceId, traceId]);

      const [first, second] = order.endsWith('first') ? [copyA, copyB] : [copyB, copyA];
      first.disable();
      expect(HttpServer.prototype.emit).toBe(wrapped);
      second.disable();
      emitTargets.forEach((target, i) => {
        expect(Object.getOwnPropertyDescriptor(target, 'emit')).toEqual(pristineEmit[i]);
      });
    },
  );
});
