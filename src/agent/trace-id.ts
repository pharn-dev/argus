import { randomBytes } from 'node:crypto';

const ALL_ZERO_TRACE_ID = '0'.repeat(32);
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/** A fresh W3C-valid trace id: 32 lowercase hex characters, never all zeros. */
export function newTraceId(): string {
  let id = randomBytes(16).toString('hex');
  while (id === ALL_ZERO_TRACE_ID) {
    id = randomBytes(16).toString('hex');
  }
  return id;
}

const ALL_ZERO_SPAN_ID = '0'.repeat(16);

/** A fresh W3C-shaped span id: 16 lowercase hex characters, never all zeros. */
export function newSpanId(): string {
  let id = randomBytes(8).toString('hex');
  while (id === ALL_ZERO_SPAN_ID) {
    id = randomBytes(8).toString('hex');
  }
  return id;
}

/**
 * Extract the trace id from a W3C `traceparent` header value. Returns the lowercased
 * trace id, or undefined when the value is absent, duplicated, malformed or all zeros.
 */
export function parseTraceparent(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = TRACEPARENT.exec(value);
  const traceId = match?.[1]?.toLowerCase();
  if (traceId === undefined || traceId === ALL_ZERO_TRACE_ID) {
    return undefined;
  }
  return traceId;
}
