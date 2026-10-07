import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCollector } from '../collector/index.js';
import { createAgentExport } from './auto-start.js';
import { sampleHeapSpaces, sampleMemory } from './index.js';
import type { AgentSample, AgentSampleLine, SpanRecord, TraceSpan } from './index.js';
import { createSpanBuffer } from './span-buffer.js';
import type { SpanDrain } from './span-buffer.js';

/** Let pending stream and generator work run to a quiet point. */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

function makeSample(timestamp: number): AgentSample {
  return {
    timestamp,
    eventLoop: { min: 1, max: 5, mean: 2, p50: 2, p99: 4 },
    memory: sampleMemory(),
    heapSpaces: sampleHeapSpaces(),
    gc: {
      count: 0,
      totalPause: 0,
      maxPause: 0,
      kinds: { minor: 0, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  };
}

let spanSeq = 0;
function makeSpan(): TraceSpan {
  spanSeq += 1;
  return {
    traceId: spanSeq.toString(16).padStart(32, '0'),
    spanId: spanSeq.toString(16).padStart(16, '0'),
    name: 'GET /',
    method: 'GET',
    path: '/',
    statusCode: 200,
    startTimeMs: 1,
    durationNs: 1000,
  };
}

/** A destination that accepts every write at once and keeps the NDJSON lines it received. */
function createCollectingWritable(): { destination: Writable; lines: () => string[] } {
  let text = '';
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      callback();
    },
  });
  return { destination, lines: () => text.split('\n').filter((l) => l.length > 0) };
}

/**
 * A destination with a 1-byte highWaterMark that withholds its write callback while stalled, so
 * the exporter can hand it one line and must queue (and drop) the rest until resume().
 */
function createStallableWritable(): {
  destination: Writable;
  lines: () => string[];
  resume: () => void;
} {
  let text = '';
  let stalled = true;
  let held: (() => void) | undefined;
  const destination = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer | string, _encoding, callback) {
      text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      if (stalled) {
        held = () => callback();
      } else {
        callback();
      }
    },
  });
  return {
    destination,
    lines: () => text.split('\n').filter((l) => l.length > 0),
    resume: () => {
      stalled = false;
      const release = held;
      held = undefined;
      release?.();
    },
  };
}

type Line = Record<string, unknown>;

function parse(lines: string[]): { samples: AgentSampleLine[]; spans: SpanRecord[] } {
  const records = lines.map((l) => JSON.parse(l) as Line);
  return {
    samples: records.filter((r) => r.type === undefined) as unknown as AgentSampleLine[],
    spans: records.filter((r) => r.type === 'span') as unknown as SpanRecord[],
  };
}

const TICKS = 10;
const SPANS_PER_TICK = 3000;
const SPAN_BUFFER = 1024;
const QUEUE_BOUND = 1024;

describe('agent export — samples survive span load, losses are reported (F-24, F-10)', () => {
  for (const pace of ['back-to-back ticks', 'ticks with the destination draining'] as const) {
    it(`3000 spans per tick for 10 ticks (${pace}): all 10 sample lines arrive and dropped.spans equals the overflow`, async () => {
      const { destination, lines } = createCollectingWritable();
      const buffer = createSpanBuffer(SPAN_BUFFER);
      const output = createAgentExport(destination, { queueBound: QUEUE_BOUND }, () =>
        buffer.drain(),
      );

      for (let tick = 0; tick < TICKS; tick += 1) {
        for (let i = 0; i < SPANS_PER_TICK; i += 1) {
          buffer.push(makeSpan());
        }
        // The auto-start tick: flush spans, then queue the sample with its loss counters.
        output.flushSpans();
        output.exportSample(makeSample(tick));
        if (pace === 'ticks with the destination draining') {
          await settle();
        }
      }
      await output.stop();

      const { samples, spans } = parse(lines());
      expect(samples.map((s) => s.timestamp)).toEqual([...Array(TICKS).keys()]);
      const overflow = TICKS * SPANS_PER_TICK - spans.length;
      expect(overflow).toBeGreaterThan(0);
      const last = samples[TICKS - 1];
      expect(last?.dropped).toEqual({ samples: 0, spans: overflow });
      expect(output.dropped).toEqual({ samples: 0, spans: overflow });
      // Every line carries integer, non-decreasing counters.
      let previous = 0;
      for (const sample of samples) {
        expect(Number.isSafeInteger(sample.dropped.spans)).toBe(true);
        expect(sample.dropped.spans).toBeGreaterThanOrEqual(previous);
        previous = sample.dropped.spans;
      }
    });
  }

  it('a stalled destination: the sample lines that do arrive carry non-zero dropped counts', async () => {
    const { destination, lines, resume } = createStallableWritable();
    const ticks = 20;
    const queueBound = 4;
    const output = createAgentExport(destination, { queueBound }, (): SpanDrain => ({
      spans: [makeSpan(), makeSpan(), makeSpan()],
      dropped: 2,
    }));

    for (let tick = 0; tick < ticks; tick += 1) {
      output.flushSpans();
      output.exportSample(makeSample(tick));
      await settle(2);
    }
    resume();
    await settle();
    await output.stop();

    const { samples } = parse(lines());
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.length).toBeLessThan(ticks);
    const last = samples[samples.length - 1];
    expect(last?.timestamp).toBe(ticks - 1);
    expect(last?.dropped.samples).toBeGreaterThan(0);
    // Tracer-side drops (2 per drain) plus span-lane drops while the destination was stalled.
    expect(last?.dropped.spans).toBeGreaterThan(ticks * 2);
    // Every sample is either delivered or counted.
    expect(samples.length + output.dropped.samples).toBe(ticks);
  });

  it('the collector accepts sample lines carrying the dropped field', async () => {
    const { destination, lines } = createCollectingWritable();
    const buffer = createSpanBuffer(4);
    const output = createAgentExport(destination, { queueBound: 16 }, () => buffer.drain());
    for (let tick = 0; tick < 3; tick += 1) {
      for (let i = 0; i < 6; i += 1) {
        buffer.push(makeSpan());
      }
      output.flushSpans();
      output.exportSample(makeSample(1_000 * tick));
    }
    await output.stop();

    const records = lines().map((l) => JSON.parse(l) as AgentSample | SpanRecord);
    const { samples } = parse(lines());
    expect(samples.every((s) => s.dropped.spans > 0)).toBe(true);

    const collector = createCollector({ windowMs: 1_000, capacity: 8 });
    await collector.consume(Readable.from(records));
    await collector.close();
    expect(collector.windows.snapshot().map((w) => w.count)).toEqual([1, 1, 1]);
    expect(collector.spans.size()).toBe(12);
  });
});
