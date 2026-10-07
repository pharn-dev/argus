import { createBoundedQueue } from './bounded-queue.js';
import type { BoundedQueue } from './bounded-queue.js';

export type TraceSpan = {
  traceId: string;
  spanId: string;
  name: string;
  method: string;
  path: string;
  statusCode: number;
  startTimeMs: number;
  durationNs: number;
};

export type SpanDrain = { spans: TraceSpan[]; dropped: number };

export type SpanBuffer = {
  readonly capacity: number;
  push(span: TraceSpan): void;
  /** Return buffered spans (oldest first) and the drop count since the last drain, then reset. */
  drain(): SpanDrain;
};

/** Bounded drop-oldest span buffer that counts the records it lost. */
export function createSpanBuffer(capacity: number): SpanBuffer {
  const queue: BoundedQueue<TraceSpan> = createBoundedQueue<TraceSpan>(capacity);
  let dropped = 0;

  return {
    capacity,
    push(span: TraceSpan): void {
      if (queue.push(span)) {
        dropped += 1;
      }
    },
    drain(): SpanDrain {
      const spans: TraceSpan[] = [];
      for (let span = queue.shift(); span !== undefined; span = queue.shift()) {
        spans.push(span);
      }
      const result = { spans, dropped };
      dropped = 0;
      return result;
    },
  };
}
