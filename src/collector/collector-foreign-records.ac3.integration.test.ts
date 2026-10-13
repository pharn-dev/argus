import { Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';

type NdjsonSkip = { reason: 'invalid'; line: string } | { reason: 'oversized'; bytes: number };

type NdjsonDecoderUnderTest = Transform & { readonly invalid: number; readonly oversized: number };

type CollectorUnderTest = {
  readonly windows: { snapshot(): unknown[] };
  readonly spans: { snapshot(): unknown[] };
  readonly ignored: number;
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: { windowMs: number; capacity: number }) => CollectorUnderTest;
  createNdjsonDecoder: (options?: {
    maxLineBytes?: number;
    onSkipped?: (skip: NdjsonSkip) => void;
  }) => NdjsonDecoderUnderTest;
};

type TraceSpan = {
  traceId: string;
  spanId: string;
  name: string;
  method: string;
  path: string;
  statusCode: number;
  startTimeMs: number;
  durationNs: number;
};

type AgentModule = {
  encodeNdjsonLine: (record: unknown) => string;
  toSpanRecord: (span: TraceSpan) => Record<string, unknown>;
};

const MAX_LINE_BYTES = 512;

/** A full agent sample line object, as the auto-started agent writes it. */
function makeSample(timestamp: number, eventLoopMax: number): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: eventLoopMax, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 100 + timestamp, heapTotal: 4000, rss: 1000, external: 0, arrayBuffers: 0 },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 1, totalStall: 4, maxStall: 4, hotspots: [] },
    dropped: { samples: 0, spans: 0 },
  };
}

function makeSpan(n: number): TraceSpan {
  return {
    traceId: `${String(n).padStart(2, '0')}${'a'.repeat(30)}`,
    spanId: `${String(n).padStart(2, '0')}${'b'.repeat(14)}`,
    name: `GET /item/${n}`,
    method: 'GET',
    path: `/item/${n}`,
    statusCode: 200,
    startTimeMs: 1_700_000_000_000 + n,
    durationNs: 1_000 * n,
  };
}

/** Split the bytes into fixed-size chunks so that lines are cut in the middle. */
function chunked(bytes: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
  }
  return chunks;
}

describe('collector over mixed stdout — AC-3', () => {
  it('AC-3: pipeline(bytes, decoder, consume) over mixed stdout resolves; windows and spans equal a clean run, collector.ignored counts the pino lines, the decoder counts text, truncated and over-long lines', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;
    const agentModule = (await import('../agent/index.js')) as unknown as AgentModule;
    const { encodeNdjsonLine, toSpanRecord } = agentModule;

    const samples = [
      makeSample(100, 50),
      makeSample(600, 70),
      makeSample(1200, 40),
      makeSample(1700, 300),
      makeSample(2300, 20),
    ];
    const spans = [makeSpan(1), makeSpan(2), makeSpan(3)].map((span) => toSpanRecord(span));

    const textLines = [
      'Server listening on http://127.0.0.1:3000',
      'GET /users 200 12ms',
      'warning: cache miss for key "users"',
    ];
    const pinoLines = [
      JSON.stringify({ level: 30, time: 1_700_000_000_000, pid: 42, msg: 'request completed' }),
      JSON.stringify({ level: 40, time: 1_700_000_000_100, pid: 42, msg: 'slow query' }),
      JSON.stringify({ level: 30, time: 1_700_000_000_200, pid: 42, msg: 'cache warmed' }),
    ];
    const truncatedLine = '{"level":30,"time":1700000000300,"msg":"cut sh';
    const overLongLine = `GET /export ${'z'.repeat(MAX_LINE_BYTES * 3)}`;

    const [s0, s1, s2, s3, s4] = samples;
    const [p0, p1, p2] = spans;
    const [t0, t1, t2] = textLines;
    const [j0, j1, j2] = pinoLines;
    const mixed =
      `${t0}\n` +
      encodeNdjsonLine(s0) +
      `${j0}\n` +
      encodeNdjsonLine(p0) +
      encodeNdjsonLine(s1) +
      `${t1}\n` +
      `${truncatedLine}\n` +
      encodeNdjsonLine(s2) +
      `${j1}\n` +
      encodeNdjsonLine(p1) +
      `${overLongLine}\n` +
      encodeNdjsonLine(s3) +
      `${t2}\n` +
      encodeNdjsonLine(p2) +
      `${j2}\n` +
      encodeNdjsonLine(s4);
    const chunks = chunked(Buffer.from(mixed, 'utf8'), 13);

    const collector = collectorModule.createCollector({ windowMs: 1000, capacity: 10 });
    const decoder = collectorModule.createNdjsonDecoder({ maxLineBytes: MAX_LINE_BYTES });

    await expect(
      pipeline(Readable.from(chunks, { objectMode: false }), decoder, (records) =>
        collector.consume(records as AsyncIterable<unknown>),
      ),
    ).resolves.toBeUndefined();

    // Reference: the same samples and spans, decoded the way the agent wrote them, no foreign lines.
    const clean = [s0, p0, s1, s2, p1, s3, p2, s4].map(
      (record) => JSON.parse(encodeNdjsonLine(record)) as unknown,
    );
    const reference = collectorModule.createCollector({ windowMs: 1000, capacity: 10 });
    await expect(reference.consume(Readable.from(clean))).resolves.toBeUndefined();

    const referenceWindows = reference.windows.snapshot();
    expect(referenceWindows.length).toBeGreaterThanOrEqual(2);
    expect(collector.windows.snapshot()).toEqual(referenceWindows);

    expect(collector.spans.snapshot()).toEqual(
      spans.map((span) => JSON.parse(encodeNdjsonLine(span)) as unknown),
    );

    expect(collector.ignored).toBe(pinoLines.length);
    expect(decoder.invalid).toBe(textLines.length + 1);
    expect(decoder.oversized).toBe(1);
  }, 10_000);
});
