/** OTLP aggregation temporality enum value for delta, emitted as the JSON integer. */
export const AGGREGATION_TEMPORALITY_DELTA = 1;

export type OtlpAnyValue = { stringValue: string };

export type OtlpKeyValue = { key: string; value: OtlpAnyValue };

export type OtlpNumberDataPoint = {
  startTimeUnixNano?: string;
  timeUnixNano: string;
  asInt: string;
};

export type OtlpGauge = { dataPoints: OtlpNumberDataPoint[] };

export type OtlpSum = {
  dataPoints: OtlpNumberDataPoint[];
  aggregationTemporality: 1;
  isMonotonic: boolean;
};

export type OtlpMetric = { name: string; description: string; unit: string } & (
  { gauge: OtlpGauge } | { sum: OtlpSum }
);

export type OtlpMetricsRequest = {
  resourceMetrics: [
    {
      resource: { attributes: OtlpKeyValue[] };
      scopeMetrics: [{ scope: { name: string }; metrics: OtlpMetric[] }];
    },
  ];
};
