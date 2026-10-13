import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';

/** Longest accepted line, in bytes, newline excluded (1 MiB). */
export const DEFAULT_MAX_LINE_BYTES = 1_048_576;

const NEWLINE = 0x0a;

/** One skipped line: text that is not a JSON object, or a line past `maxLineBytes`. */
export type NdjsonSkip =
  { reason: 'invalid'; line: string } | { reason: 'oversized'; bytes: number };

export type NdjsonDecoderOptions = {
  /** Longest accepted line in bytes, newline excluded. Longer lines are dropped and counted. */
  maxLineBytes?: number;
  /** Called once per skipped line, after the counter is incremented. A throw errors the decoder. */
  onSkipped?: (skip: NdjsonSkip) => void;
};

/** Byte stream in, parsed objects out; counters are integers and read-only. */
export type NdjsonDecoder = Transform & {
  readonly invalid: number;
  readonly oversized: number;
};

function saturatingAdd(a: number, b: number): number {
  const sum = a + b;
  return sum > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : sum;
}

/**
 * Newline-delimited JSON decoder for a stdout the app shares with the agent.
 * Lines that are not a JSON object (plain text, truncated JSON, numbers, arrays) or that exceed
 * `maxLineBytes` are skipped and counted, never thrown. Held memory per partial line never exceeds
 * `maxLineBytes`. Wire it with `pipeline(input, decoder, (records) => collector.consume(records))`.
 */
export function createNdjsonDecoder(options: NdjsonDecoderOptions = {}): NdjsonDecoder {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new RangeError('maxLineBytes must be a positive safe integer');
  }
  const { onSkipped } = options;
  if (onSkipped !== undefined && typeof onSkipped !== 'function') {
    throw new TypeError('onSkipped must be a function');
  }

  let invalid = 0;
  let oversized = 0;
  // The partial line: copied slices plus their total length, never more than maxLineBytes.
  let slices: Buffer[] = [];
  let held = 0;
  // Set once the partial line passed maxLineBytes: bytes are only counted until the next newline.
  let discarding = false;
  let discardedBytes = 0;

  // Bound to the Transform's `push` once it exists; the line handlers above are defined first.
  let emit: (record: Record<string, unknown>) => void = () => undefined;

  const skip = (entry: NdjsonSkip): void => {
    if (entry.reason === 'invalid') {
      invalid = saturatingAdd(invalid, 1);
    } else {
      oversized = saturatingAdd(oversized, 1);
    }
    onSkipped?.(entry);
  };

  const decodeLine = (line: Buffer): void => {
    const text = line.toString('utf8');
    if (text.trim() === '') {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      skip({ reason: 'invalid', line: text });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      skip({ reason: 'invalid', line: text });
      return;
    }
    emit(parsed as Record<string, unknown>);
  };

  const resetLine = (): void => {
    slices = [];
    held = 0;
    discarding = false;
    discardedBytes = 0;
  };

  /** Bytes of a line that continues into the next chunk. */
  const holdPartial = (segment: Buffer): void => {
    if (discarding) {
      discardedBytes = saturatingAdd(discardedBytes, segment.length);
      return;
    }
    if (held + segment.length > maxLineBytes) {
      discarding = true;
      discardedBytes = saturatingAdd(held, segment.length);
      slices = [];
      held = 0;
      return;
    }
    // Copy: a subarray would keep the whole source chunk alive.
    slices.push(Buffer.from(segment));
    held += segment.length;
  };

  /** The final segment of a line, with its newline (or end of input) reached. */
  const finishLine = (segment: Buffer): void => {
    if (discarding) {
      const bytes = saturatingAdd(discardedBytes, segment.length);
      resetLine();
      skip({ reason: 'oversized', bytes });
      return;
    }
    const total = held + segment.length;
    if (total > maxLineBytes) {
      resetLine();
      skip({ reason: 'oversized', bytes: total });
      return;
    }
    const line = slices.length === 0 ? segment : Buffer.concat([...slices, segment], total);
    resetLine();
    decodeLine(line);
  };

  const decoder = new Transform({
    writableObjectMode: false,
    readableObjectMode: true,
    transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
      try {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk;
        let position = 0;
        while (position < bytes.length) {
          const newline = bytes.indexOf(NEWLINE, position);
          if (newline === -1) {
            holdPartial(bytes.subarray(position));
            break;
          }
          finishLine(bytes.subarray(position, newline));
          position = newline + 1;
        }
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback: TransformCallback): void {
      try {
        if (discarding || held > 0) {
          finishLine(Buffer.alloc(0));
        }
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  emit = (record) => {
    decoder.push(record);
  };

  Object.defineProperties(decoder, {
    invalid: { get: (): number => invalid, enumerable: true },
    oversized: { get: (): number => oversized, enumerable: true },
  });
  return decoder as NdjsonDecoder;
}
