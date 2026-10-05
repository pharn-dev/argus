import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type ExporterUnderTest = {
  export(record: unknown): void;
  stop(): Promise<void>;
  readonly done: Promise<void>;
};

/** A Writable that records every byte it receives. */
function createRecordingWritable(): { destination: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  return { destination, text: () => Buffer.concat(chunks).toString('utf8') };
}

describe('agent NDJSON export — AC-1', () => {
  it('AC-1: three exported objects arrive as exactly three newline-terminated JSON lines, in order', async () => {
    const { createNdjsonExporter } = await import('./index.js');

    const { destination, text } = createRecordingWritable();
    const exporter = (createNdjsonExporter as (destination: Writable) => ExporterUnderTest)(
      destination,
    );

    const inputs = [
      { kind: 'first', value: 1, nested: { ok: true } },
      { kind: 'second', value: 'two', list: [1, 2, 3] },
      { kind: 'third', value: null, text: 'line\nbreak inside a string' },
    ];
    for (const input of inputs) {
      exporter.export(input);
    }

    await exporter.stop();
    await exporter.done;

    const received = text();
    expect(received.endsWith('\n')).toBe(true);

    const parts = received.split('\n');
    // Three lines plus the empty string after the final '\n'.
    expect(parts).toHaveLength(4);
    expect(parts[3]).toBe('');

    const lines = parts.slice(0, 3);
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(0);
    }
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual(inputs);
  }, 10_000);
});
