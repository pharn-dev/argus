import type { TraceSpan } from './span-buffer.js';

/** Discriminator on a span line; sample lines carry no `type`. */
export const SPAN_RECORD_TYPE = 'span';

export type SpanRecord = { type: typeof SPAN_RECORD_TYPE } & TraceSpan;

export function toSpanRecord(span: TraceSpan): SpanRecord {
  return { type: SPAN_RECORD_TYPE, ...span };
}

export function isSpanRecord(value: unknown): value is SpanRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === SPAN_RECORD_TYPE
  );
}
