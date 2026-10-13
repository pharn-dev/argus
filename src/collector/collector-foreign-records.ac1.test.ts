import { Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';

type NdjsonSkip = { reason: 'invalid'; line: string } | { reason: 'oversized'; bytes: number };

type NdjsonDecoderUnderTest = Transform & { readonly invalid: number; readonly oversized: number };

type CollectorModule = {
  createNdjsonDecoder: (options?: {
    maxLineBytes?: number;
    onSkipped?: (skip: NdjsonSkip) => void;
  }) => NdjsonDecoderUnderTest;
};

/** A full agent sample line object at the given timestamp. */
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
    dropped: { samples: 0, spans: 0 },
  };
}

const pino = { level: 30, time: 1_700_000_000_000, msg: 'hi' };
const sample = makeSample(1000);
const span = {
  type: 'span',
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  name: 'GET /users',
  method: 'GET',
  path: '/users',
  statusCode: 200,
  startTimeMs: 1_700_000_000_000,
  durationNs: 1_500_000,
};
const finalObject = { final: true, n: 7 };

const overLongLine = JSON.stringify({ msg: 'x'.repeat(2100) });

/** The mixed input, in order; the final object line has no trailing newline. */
const text =
  'server listening on port 3000\n' +
  `${JSON.stringify(pino)}\n` +
  `${JSON.stringify(sample)}\n` +
  '\n' +
  '{"timestamp":1000,"eventLoop":{"max":\n' +
  `${overLongLine}\n` +
  `${JSON.stringify(span)}\n` +
  '42\n' +
  JSON.stringify(finalObject);

/** Split the bytes into fixed-size chunks so that most lines are cut in the middle. */
function chunked(bytes: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
  }
  return chunks;
}

describe('collector NDJSON decoder — AC-1', () => {
  it('AC-1: decodes mixed stdout split across chunk boundaries, emits only the JSON objects in order, and counts 3 invalid and 1 oversized line with 4 hook calls', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;
    expect(typeof collectorModule.createNdjsonDecoder).toBe('function');

    const skipped: NdjsonSkip[] = [];
    const decoder = collectorModule.createNdjsonDecoder({
      maxLineBytes: 1024,
      onSkipped(skip) {
        skipped.push(skip);
      },
    });

    expect(Buffer.byteLength(overLongLine)).toBeGreaterThanOrEqual(2048);
    expect(Buffer.byteLength(JSON.stringify(sample))).toBeLessThan(1024);
    const chunks = chunked(Buffer.from(text, 'utf8'), 7);
    expect(chunks.length).toBeGreaterThan(10);

    const emitted: unknown[] = [];
    await expect(
      pipeline(Readable.from(chunks, { objectMode: false }), decoder, async (records) => {
        for await (const record of records as AsyncIterable<unknown>) {
          emitted.push(record);
        }
      }),
    ).resolves.toBeUndefined();

    expect(emitted).toEqual([pino, sample, span, finalObject]);
    expect(decoder.invalid).toBe(3);
    expect(decoder.oversized).toBe(1);
    expect(Number.isInteger(decoder.invalid)).toBe(true);
    expect(Number.isInteger(decoder.oversized)).toBe(true);
    expect(skipped).toHaveLength(4);
    expect(skipped.filter((skip) => skip.reason === 'invalid')).toHaveLength(3);
    expect(skipped.filter((skip) => skip.reason === 'oversized')).toHaveLength(1);
  }, 10_000);
});
