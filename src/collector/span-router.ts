import { Transform } from 'node:stream';
import { isSpanRecord } from '../agent/index.js';
import type { SpanRecord } from '../agent/index.js';

/** Divert span records to `onSpan`; forward every other chunk unchanged. */
export function createSpanRouter(onSpan: (span: SpanRecord) => void): Transform {
  return new Transform({
    objectMode: true,
    transform(chunk: unknown, _encoding, callback): void {
      if (!isSpanRecord(chunk)) {
        callback(null, chunk);
        return;
      }
      try {
        onSpan(chunk);
      } catch (error) {
        callback(error as Error);
        return;
      }
      callback();
    },
  });
}
