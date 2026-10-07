import type { AgentSample } from './sampler-controller.js';
import type { TraceSpan } from './span-buffer.js';

/** Discriminator on a span line; sample lines carry no `type`. */
export const SPAN_RECORD_TYPE = 'span';

export type SpanRecord = { type: typeof SPAN_RECORD_TYPE } & TraceSpan;

/**
 * Cumulative integer counts of records the agent discarded since it started, as carried on every
 * sample line. `samples`: sample lines dropped by the output queue. `spans`: spans dropped by the
 * tracer's buffer or by the output queue's span lane.
 */
export type AgentLossCounters = { samples: number; spans: number };

/** A sample line as the auto-started agent writes it: the sample plus its loss accounting. */
export type AgentSampleLine = AgentSample & { dropped: AgentLossCounters };

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
