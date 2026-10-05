import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type AlertOutput = {
  ruleId: string;
  metric: string;
  comparison: string;
  threshold: number;
  observed: number;
  windowStart: number;
  windowEnd: number;
  state: string;
};

type AlertSinkUnderTest = {
  readonly type: string;
  readonly name: string | undefined;
  readonly failed: number;
  readonly dropped: number;
  send(alert: AlertOutput): Promise<void>;
  close(): Promise<void>;
};

type SinkModule = {
  createStdoutSink: (options?: {
    stream?: Writable;
    name?: string;
    onError?: (error: Error, sink: AlertSinkUnderTest) => void;
  }) => AlertSinkUnderTest;
  createFileSink: (options: {
    path: string;
    name?: string;
    onError?: (error: Error, sink: AlertSinkUnderTest) => void;
  }) => AlertSinkUnderTest;
};

const firing: AlertOutput = {
  ruleId: 'loop-max',
  metric: 'eventLoop.max',
  comparison: '>',
  threshold: 100,
  observed: 500,
  windowStart: 1000,
  windowEnd: 2000,
  state: 'firing',
};

const resolved: AlertOutput = {
  ruleId: 'loop-max',
  metric: 'eventLoop.max',
  comparison: '>',
  threshold: 100,
  observed: 50,
  windowStart: 2000,
  windowEnd: 3000,
  state: 'resolved',
};

/** Splits NDJSON text into its non-empty lines. */
function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.length > 0);
}

describe('collector alert sinks — AC-1', () => {
  it('AC-1: stdout and file sinks write one NDJSON line per alert in order, without ending the stream or truncating the file', async () => {
    const sinkModule = (await import('./index.js')) as unknown as SinkModule;

    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        callback();
      },
    });

    const dir = await mkdtemp(join(tmpdir(), 'argus-alert-sinks-'));
    try {
      const path = join(dir, 'alerts.ndjson');
      await writeFile(path, '{"original":true}\n', 'utf8');

      const stdoutSink = sinkModule.createStdoutSink({ stream });
      const fileSink = sinkModule.createFileSink({ path });

      await stdoutSink.send(firing);
      await stdoutSink.send(resolved);
      await stdoutSink.close();

      await fileSink.send(firing);
      await fileSink.send(resolved);
      await fileSink.close();

      const written = lines(chunks.join(''));
      expect(written).toHaveLength(2);
      expect(written.map((line) => JSON.parse(line) as unknown)).toEqual([firing, resolved]);
      expect(stream.writableEnded).toBe(false);
      expect(stream.destroyed).toBe(false);

      const fileLines = lines(await readFile(path, 'utf8'));
      expect(fileLines).toHaveLength(3);
      expect(JSON.parse(fileLines[0] ?? '') as unknown).toEqual({ original: true });
      expect(fileLines.slice(1).map((line) => JSON.parse(line) as unknown)).toEqual([
        firing,
        resolved,
      ]);

      expect(stdoutSink.failed).toBe(0);
      expect(fileSink.failed).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
