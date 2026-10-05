import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AgentSample } from './index.js';

type ExporterUnderTest = {
  export(record: unknown): void;
  stop(): Promise<void>;
  readonly done: Promise<void>;
};

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await delay(5);
  }
}

describe('agent NDJSON export — AC-3', () => {
  it('AC-3: controller samples reach the destination as NDJSON until it errors; done rejects with that error and nothing is written afterwards', async () => {
    const { createNdjsonExporter, createSamplerController } = await import('./index.js');

    const intervalMs = 20;
    const boom = new Error('destination failed');
    const linesBeforeError: string[] = [];
    let partial = '';
    let failNext = false;
    let rejected = false;
    let writeCallsAfterRejection = 0;

    const destination = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        if (failNext) {
          callback(boom);
          return;
        }
        const pieces = (partial + chunk.toString()).split('\n');
        partial = pieces.pop() ?? '';
        linesBeforeError.push(...pieces);
        callback();
      },
    });
    const originalWrite = destination.write.bind(destination) as (
      chunk: unknown,
      ...rest: unknown[]
    ) => boolean;
    destination.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (rejected) {
        writeCallsAfterRejection += 1;
      }
      return originalWrite(chunk, ...rest);
    }) as Writable['write'];

    const exporter = (createNdjsonExporter as (destination: Writable) => ExporterUnderTest)(
      destination,
    );
    const controller = createSamplerController((sample: AgentSample) => {
      exporter.export(sample);
    });

    try {
      controller.start(intervalMs);
      await waitFor(() => linesBeforeError.length >= 3, 5_000);

      failNext = true;
      let caught: unknown;
      try {
        await exporter.done;
      } catch (error) {
        caught = error;
      }
      rejected = true;
      expect(caught).toBe(boom);

      const linesAtRejection = linesBeforeError.length;
      expect(linesAtRejection).toBeGreaterThanOrEqual(3);
      for (const line of linesBeforeError) {
        const sample = JSON.parse(line) as Partial<AgentSample>;
        expect(Number.isInteger(sample.timestamp)).toBe(true);
        expect(typeof sample.eventLoop).toBe('object');
        expect(sample.eventLoop).not.toBeNull();
        expect(typeof sample.memory).toBe('object');
        expect(sample.memory).not.toBeNull();
      }

      // Let the controller tick several more times: nothing further reaches the destination.
      await delay(intervalMs * 8);
      expect(writeCallsAfterRejection).toBe(0);
      expect(linesBeforeError.length).toBe(linesAtRejection);
    } finally {
      controller.stop();
    }
  }, 10_000);
});
