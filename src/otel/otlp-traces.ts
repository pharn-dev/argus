import type { SpanRecord } from '../collector/index.js';
import {
  SPAN_KIND_SERVER,
  STATUS_CODE_ERROR,
  STATUS_CODE_UNSET,
  type OtlpSpan,
  type OtlpTraceKeyValue,
  type OtlpTracesRequest,
} from './otlp-trace-types.js';

const DEFAULT_SERVICE_NAME = 'argus';
const SCOPE_NAME = 'argus';
const NANOS_PER_MS = 1_000_000n;

// Anchored, fixed-length character classes: linear time, no backtracking.
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

function requireNonNegativeSafeInteger(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`span ${field} must be a non-negative safe integer`);
  }
}

/**
 * Ids pass through unchanged. The agent already makes OTLP-sized ids (src/agent/trace-id.ts):
 * traceId is randomBytes(16) and spanId randomBytes(8), hex-encoded, and inbound `traceparent`
 * ids are lowercased, so they are 32 and 16 lowercase hex characters, which is what OTLP JSON
 * wants. A malformed id is rejected, never repaired: the whole conversion throws a RangeError
 * that names the field (never the id value). The exporter turns that into one failed batch
 * reported through `onError`.
 */
function toOtlpSpan(record: SpanRecord): OtlpSpan {
  if (!TRACE_ID_PATTERN.test(record.traceId)) {
    throw new RangeError('span traceId must be 32 lowercase hex characters');
  }
  if (!SPAN_ID_PATTERN.test(record.spanId)) {
    throw new RangeError('span spanId must be 16 lowercase hex characters');
  }
  requireNonNegativeSafeInteger('startTimeMs', record.startTimeMs);
  requireNonNegativeSafeInteger('durationNs', record.durationNs);
  requireNonNegativeSafeInteger('statusCode', record.statusCode);

  const start = BigInt(record.startTimeMs) * NANOS_PER_MS;
  const end = start + BigInt(record.durationNs);
  const attributes: OtlpTraceKeyValue[] = [
    { key: 'http.request.method', value: { stringValue: record.method } },
    { key: 'url.path', value: { stringValue: record.path } },
    { key: 'http.response.status_code', value: { intValue: String(record.statusCode) } },
  ];
  const isServerError = record.statusCode >= 500 && record.statusCode <= 599;
  return {
    traceId: record.traceId,
    spanId: record.spanId,
    name: record.name,
    kind: SPAN_KIND_SERVER,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: end.toString(),
    attributes,
    status: { code: isServerError ? STATUS_CODE_ERROR : STATUS_CODE_UNSET },
  };
}

/**
 * Converts span records to one OTLP/HTTP JSON traces request: one resource, one scope, one
 * span per record in input order. Pure and synchronous. Throws a RangeError for a record with a
 * malformed id or a non-integer time or status.
 */
export function toOtlpTraces(
  spans: SpanRecord | readonly SpanRecord[],
  options: { serviceName?: string } = {},
): OtlpTracesRequest {
  const records = Array.isArray(spans) ? (spans as readonly SpanRecord[]) : [spans as SpanRecord];
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: { stringValue: options.serviceName ?? DEFAULT_SERVICE_NAME },
            },
          ],
        },
        scopeSpans: [{ scope: { name: SCOPE_NAME }, spans: records.map(toOtlpSpan) }],
      },
    ],
  };
}
