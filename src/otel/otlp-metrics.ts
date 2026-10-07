import type { AggregatedWindow } from '../collector/index.js';
import {
  AGGREGATION_TEMPORALITY_DELTA,
  type OtlpMetric,
  type OtlpMetricsRequest,
  type OtlpNumberDataPoint,
} from './otlp-types.js';

/** Converts epoch milliseconds to an exact epoch-nanosecond decimal string. */
export function msToUnixNano(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError(`timestamp must be a non-negative safe integer, got ${String(ms)}`);
  }
  return (BigInt(ms) * 1_000_000n).toString();
}

/** Converts a non-negative safe integer to its decimal string (OTLP JSON `asInt`). */
export function toIntString(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`metric value must be a non-negative safe integer, got ${String(value)}`);
  }
  return String(value);
}

type GaugeSpec = {
  name: string;
  description: string;
  unit: string;
  read: (window: AggregatedWindow) => number;
};

const GAUGES: readonly GaugeSpec[] = [
  {
    name: 'argus.event_loop.lag.max',
    description: 'Maximum event loop lag in the window',
    unit: 'ns',
    read: (w) => w.eventLoop.max,
  },
  {
    name: 'argus.event_loop.lag.p99',
    description: '99th percentile event loop lag in the window',
    unit: 'ns',
    read: (w) => w.eventLoop.p99,
  },
  {
    name: 'argus.event_loop.lag.mean',
    description: 'Mean event loop lag in the window',
    unit: 'ns',
    read: (w) => w.eventLoop.mean,
  },
  {
    name: 'argus.memory.heap_used.last',
    description: 'Heap used at the end of the window',
    unit: 'By',
    read: (w) => w.memory.heapUsedLast,
  },
  {
    name: 'argus.memory.heap_used.max',
    description: 'Maximum heap used in the window',
    unit: 'By',
    read: (w) => w.memory.heapUsedMax,
  },
  {
    name: 'argus.memory.rss.last',
    description: 'Resident set size at the end of the window',
    unit: 'By',
    read: (w) => w.memory.rssLast,
  },
  {
    name: 'argus.memory.rss.max',
    description: 'Maximum resident set size in the window',
    unit: 'By',
    read: (w) => w.memory.rssMax,
  },
];

/**
 * Converts aggregated windows to an OTLP/HTTP JSON metrics request. Pure and synchronous; the
 * result contains only plain objects, arrays and strings.
 */
export function toOtlpMetrics(
  windows: AggregatedWindow | readonly AggregatedWindow[],
  options: { serviceName?: string } = {},
): OtlpMetricsRequest {
  const list: readonly AggregatedWindow[] = Array.isArray(windows)
    ? (windows as readonly AggregatedWindow[])
    : [windows as AggregatedWindow];

  const metrics: OtlpMetric[] = GAUGES.map((spec) => ({
    name: spec.name,
    description: spec.description,
    unit: spec.unit,
    gauge: {
      dataPoints: list.map((window): OtlpNumberDataPoint => ({
        timeUnixNano: msToUnixNano(window.end),
        asInt: toIntString(spec.read(window)),
      })),
    },
  }));

  metrics.push({
    name: 'argus.gc.count',
    description: 'Garbage collections in the window',
    unit: '{collection}',
    sum: {
      dataPoints: list.map((window): OtlpNumberDataPoint => ({
        startTimeUnixNano: msToUnixNano(window.start),
        timeUnixNano: msToUnixNano(window.end),
        asInt: toIntString(window.gc.count),
      })),
      aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
      isMonotonic: true,
    },
  });

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: options.serviceName ?? 'argus' } },
          ],
        },
        scopeMetrics: [{ scope: { name: 'argus' }, metrics }],
      },
    ],
  };
}
