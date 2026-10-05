import { once } from 'node:events';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type SampleUnderTest = {
  events: number;
  totalStall: number;
  maxStall: number;
  hotspots: { site: string; events: number; totalStall: number; maxStall: number }[];
};
type ProbeUnderTest = { enable(): void; disable(): void; sample(): SampleUnderTest };
type ExporterUnderTest = {
  export(record: unknown): void;
  stop(): Promise<void>;
  readonly done: Promise<void>;
};

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

async function loadAgent(): Promise<Record<string, unknown>> {
  return (await import('./index.js')) as unknown as Record<string, unknown>;
}

/** A Writable with a 1-byte highWaterMark that acknowledges each chunk after a short delay. */
function createSlowWritable(): Writable {
  return new Writable({
    highWaterMark: 1,
    write(_chunk: Buffer | string, _encoding, callback) {
      setTimeout(() => callback(), 2);
    },
  });
}

async function stallOnce(stream: Writable): Promise<void> {
  let accepted = true;
  let guard = 0;
  while (accepted) {
    accepted = stream.write('x');
    guard += 1;
    if (guard > 1000) throw new Error('write() never returned false');
  }
  await once(stream, 'drain');
}

/** A 1-byte highWaterMark Writable that withholds its write callback until resume(). */
function createStallableWritable(): { destination: Writable; resume: () => void } {
  let stalled = true;
  let held: (() => void) | undefined;
  const destination = new Writable({
    highWaterMark: 1,
    write(_chunk: Buffer | string, _encoding, callback) {
      if (stalled) {
        held = () => callback();
      } else {
        callback();
      }
    },
  });
  return {
    destination,
    resume: () => {
      stalled = false;
      const release = held;
      held = undefined;
      release?.();
    },
  };
}

describe('agent backpressure probes — AC-2', () => {
  it('AC-2: enabling twice then disabling once restores the identical Writable.prototype.write and stops counting', async () => {
    const original = Writable.prototype.write;
    const agent = await loadAgent();
    const createBackpressureProbe = agent['createBackpressureProbe'] as () => ProbeUnderTest;
    expect(typeof createBackpressureProbe).toBe('function');

    const probe = createBackpressureProbe();
    try {
      probe.enable();
      probe.enable();
      probe.disable();

      expect(Writable.prototype.write === original).toBe(true);

      const stream = createSlowWritable();
      await stallOnce(stream);
      stream.destroy();

      const reading = probe.sample();
      expect(reading.events).toBe(0);
      expect(reading.totalStall).toBe(0);
      expect(reading.hotspots).toEqual([]);
    } finally {
      probe.disable();
      Writable.prototype.write = original;
    }
  }, 10_000);

  it("AC-2: a stall on an NDJSON exporter's destination is never counted while the probe is enabled", async () => {
    const original = Writable.prototype.write;
    const agent = await loadAgent();
    const createBackpressureProbe = agent['createBackpressureProbe'] as () => ProbeUnderTest;
    const createNdjsonExporter = agent['createNdjsonExporter'] as (
      destination: Writable,
      options?: { queueBound?: number },
    ) => ExporterUnderTest;
    expect(typeof createBackpressureProbe).toBe('function');
    expect(typeof createNdjsonExporter).toBe('function');

    const probe = createBackpressureProbe();
    probe.enable();
    try {
      const { destination, resume } = createStallableWritable();
      const exporter = createNdjsonExporter(destination, { queueBound: 4 });
      for (let seq = 0; seq < 6; seq += 1) {
        exporter.export({ seq });
        await settle(2);
      }
      await settle();

      // The exporter's destination really is stalled on backpressure.
      expect(destination.writableNeedDrain).toBe(true);

      // Control: a plain stream's stall during the same window is counted, the exporter's is not.
      const control = createSlowWritable();
      await stallOnce(control);
      control.destroy();

      const whileStalled = probe.sample();
      expect(whileStalled.events).toBe(1);

      resume();
      await exporter.stop();
      await exporter.done;
      await settle();

      const afterDrain = probe.sample();
      expect(afterDrain.events).toBe(0);
      expect(afterDrain.totalStall).toBe(0);
      expect(afterDrain.hotspots).toEqual([]);
    } finally {
      probe.disable();
      Writable.prototype.write = original;
    }
  }, 10_000);
});
