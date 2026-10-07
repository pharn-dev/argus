/** OTLP span kind enum value for SERVER, emitted as the JSON integer. */
export const SPAN_KIND_SERVER = 2;

/** OTLP status code enum value for UNSET, emitted as the JSON integer. */
export const STATUS_CODE_UNSET = 0;

/** OTLP status code enum value for ERROR, emitted as the JSON integer. */
export const STATUS_CODE_ERROR = 2;

/** OTLP JSON carries 64-bit integers as decimal strings. */
export type OtlpTraceAnyValue = { stringValue: string } | { intValue: string };

export type OtlpTraceKeyValue = { key: string; value: OtlpTraceAnyValue };

export type OtlpStatus = {
  code: typeof STATUS_CODE_UNSET | typeof STATUS_CODE_ERROR;
  message?: string;
};

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  name: string;
  kind: typeof SPAN_KIND_SERVER;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpTraceKeyValue[];
  status: OtlpStatus;
};

export type OtlpTracesRequest = {
  resourceSpans: [
    {
      resource: { attributes: OtlpTraceKeyValue[] };
      scopeSpans: [{ scope: { name: string }; spans: OtlpSpan[] }];
    },
  ];
};
