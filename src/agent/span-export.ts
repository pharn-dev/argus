import type { SpanDrain } from './span-buffer.js';
import { toSpanRecord } from './span-record.js';
import type { SpanRecord } from './span-record.js';

export type SpanExport = {
  /** Move every buffered span to `emit`, oldest first. */
  flush(): void;
  /** Integer total of spans the tracer's buffer dropped before they could be flushed. */
  readonly dropped: number;
};

export function createSpanExport(
  drain: () => SpanDrain,
  emit: (record: SpanRecord) => void,
): SpanExport {
  let dropped = 0;
  return {
    flush(): void {
      const result = drain();
      dropped += result.dropped;
      for (const span of result.spans) {
        emit(toSpanRecord(span));
      }
    },
    get dropped(): number {
      return dropped;
    },
  };
}
