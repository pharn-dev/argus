import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type ExporterUnderTest = {
  export(record: unknown): void;
  readonly dropped: number;
  stop(): Promise<void>;
  readonly done: Promise<void>;
};

/** Let pending stream and generator work run to a quiet point. */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

/**
 * A Writable with a 1-byte highWaterMark, so every write() returns false. While
 * stalled it withholds the write callback, so it emits no 'drain' and accepts
 * nothing further until resume(). Accepted records are counted in its own
 * write path (one NDJSON line per record).
 */
function createStallableWritable(): {
  destination: Writable;
  acceptedLines: () => string[];
  resume: () => void;
} {
  const lines: string[] = [];
  let partial = '';
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

  const originalWrite = destination.write.bind(destination) as (
    chunk: unknown,
    ...rest: unknown[]
  ) => boolean;
  // Count every record handed to write(), including the one whose write() returned false.
  destination.write = ((chunk: unknown, ...rest: unknown[]) => {
    const asText = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const pieces = (partial + asText).split('\n');
    partial = pieces.pop() ?? '';
    lines.push(...pieces);
    return originalWrite(chunk, ...rest);
  }) as Writable['write'];

  return {
    destination,
    acceptedLines: () => [...lines],
    resume: () => {
      stalled = false;
      const release = held;
      held = undefined;
      release?.();
    },
  };
}

describe('agent NDJSON export — AC-2', () => {
  it('AC-2: a stalled destination drops the oldest records beyond the bound, counts them, and later receives the newest N in order', async () => {
    const { createNdjsonExporter } = await import('./index.js');

    const N = 3;
    const total = 12;
    const { destination, acceptedLines, resume } = createStallableWritable();
    const exporter = (
      createNdjsonExporter as (
        destination: Writable,
        options: { queueBound: number },
      ) => ExporterUnderTest
    )(destination, { queueBound: N });

    const records = Array.from({ length: total }, (_, seq) => ({ seq, tag: `record-${seq}` }));
    for (const record of records) {
      exporter.export(record);
      await settle(2);
    }
    await settle();

    const acceptedDuringStall = acceptedLines().length;
    // The criterion needs more than N records beyond what the destination accepted.
    expect(total - acceptedDuringStall).toBeGreaterThan(N);

    const dropped = exporter.dropped;
    expect(Number.isInteger(dropped)).toBe(true);
    expect(dropped).toBe(total - acceptedDuringStall - N);

    resume();
    await exporter.stop();
    await exporter.done;

    const afterStall = acceptedLines()
      .slice(acceptedDuringStall)
      .map((line) => JSON.parse(line) as unknown);
    expect(afterStall).toEqual(records.slice(total - N));

    // Every older stalled record is absent from everything the destination received.
    const allSeqs = acceptedLines().map((line) => (JSON.parse(line) as { seq: number }).seq);
    const stalledOlder = records.slice(acceptedDuringStall, total - N).map((record) => record.seq);
    for (const seq of stalledOlder) {
      expect(allSeqs).not.toContain(seq);
    }
  }, 10_000);
});
