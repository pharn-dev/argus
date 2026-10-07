import { describe, expect, it } from 'vitest';

type SpanRecord = {
  type: 'span';
  traceId: string;
  spanId: string;
  name: string;
  method: string;
  path: string;
  statusCode: number;
  startTimeMs: number;
  durationNs: number;
};

type AnyValue = { stringValue?: string; intValue?: string | number };

type KeyValue = { key: string; value: AnyValue };

type Span = {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  status?: { code?: number };
};

type TracesRequest = {
  resourceSpans: { scopeSpans: { spans: Span[] }[] }[];
};

type OtelModule = {
  toOtlpTraces: (
    spans: SpanRecord | readonly SpanRecord[],
    options?: { serviceName?: string },
  ) => TracesRequest;
};

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

function makeSpan(spanId: string, statusCode: number): SpanRecord {
  return {
    type: 'span',
    traceId: TRACE_ID,
    spanId,
    name: 'GET /users',
    method: 'GET',
    path: '/users',
    statusCode,
    startTimeMs: 1700000000123,
    durationNs: 1234567,
  };
}

function attribute(span: Span, key: string): AnyValue | undefined {
  return span.attributes.find((entry) => entry.key === key)?.value;
}

describe('otel trace export — AC-1', () => {
  it('AC-1: converts two span records into one resourceSpans entry holding two SERVER spans', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const ok = makeSpan('b7ad6b7169203331', 200);
    const failed = makeSpan('00f067aa0ba902b7', 503);

    const result = otel.toOtlpTraces([ok, failed]);

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result.resourceSpans).toHaveLength(1);
    const scopeSpans = result.resourceSpans[0]?.scopeSpans ?? [];
    const spans = scopeSpans.flatMap((scope) => scope.spans);
    expect(spans).toHaveLength(2);

    const bySpanId = new Map(spans.map((span) => [span.spanId, span]));
    expect([...bySpanId.keys()].sort()).toEqual(['00f067aa0ba902b7', 'b7ad6b7169203331']);

    for (const record of [ok, failed]) {
      const span = bySpanId.get(record.spanId);
      expect(span).toBeDefined();
      if (span === undefined) continue;
      expect(span.traceId).toBe(TRACE_ID);
      expect(span.spanId).toBe(record.spanId);
      expect(span.name).toBe('GET /users');
      expect(span.kind).toBe(2);
      expect(span.startTimeUnixNano).toBe('1700000000123000000');
      expect(span.endTimeUnixNano).toBe('1700000000124234567');
      expect(attribute(span, 'http.request.method')).toEqual({ stringValue: 'GET' });
      expect(attribute(span, 'url.path')).toEqual({ stringValue: '/users' });
      const status = attribute(span, 'http.response.status_code');
      expect(status?.intValue).toBeDefined();
      expect(Number(status?.intValue)).toBe(record.statusCode);
    }

    expect(bySpanId.get('00f067aa0ba902b7')?.status?.code).toBe(2);
    expect(bySpanId.get('b7ad6b7169203331')?.status?.code).not.toBe(2);
  });
});
