import { describe, expect, it } from 'vitest';

type Window = {
  start: number;
  end: number;
  count: number;
  late: number;
  eventLoop: { max: number; p99: number; mean: number };
  memory: { heapUsedLast: number; heapUsedMax: number; rssLast: number; rssMax: number };
  gc: { count: number; totalPause: number; maxPause: number };
  backpressure: { events: number; totalStall: number; maxStall: number };
};

type DataPoint = { startTimeUnixNano?: string; timeUnixNano: string; asInt: string };

type Metric = {
  name: string;
  unit: string;
  gauge?: { dataPoints: DataPoint[] };
  sum?: { dataPoints: DataPoint[]; aggregationTemporality: number; isMonotonic: boolean };
};

type MetricsRequest = {
  resourceMetrics: { scopeMetrics: { metrics: Metric[] }[] }[];
};

type OtelModule = {
  toOtlpMetrics: (windows: Window | readonly Window[]) => MetricsRequest;
};

const window: Window = {
  start: 1700000000000,
  end: 1700000001000,
  count: 10,
  late: 0,
  eventLoop: { max: 5000000, p99: 4000000, mean: 2000000 },
  memory: { heapUsedLast: 1000, heapUsedMax: 2000, rssLast: 3000, rssMax: 4000 },
  gc: { count: 7, totalPause: 0, maxPause: 0 },
  backpressure: { events: 0, totalStall: 0, maxStall: 0 },
};

describe('otel metrics export — AC-1', () => {
  it('AC-1: converts one aggregated window into OTLP JSON gauges and a delta GC sum with exact nanosecond strings', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const result = otel.toOtlpMetrics(window);

    expect(JSON.parse(JSON.stringify(result)) as unknown).toEqual(result);
    expect(result.resourceMetrics).toHaveLength(1);
    const metrics = result.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
    const byName = new Map(metrics.map((metric) => [metric.name, metric]));

    const gauges: [string, number][] = [
      ['argus.event_loop.lag.max', 5000000],
      ['argus.event_loop.lag.p99', 4000000],
      ['argus.event_loop.lag.mean', 2000000],
      ['argus.memory.heap_used.last', 1000],
      ['argus.memory.heap_used.max', 2000],
      ['argus.memory.rss.last', 3000],
      ['argus.memory.rss.max', 4000],
    ];
    for (const [name, value] of gauges) {
      const points = byName.get(name)?.gauge?.dataPoints;
      expect(points, name).toHaveLength(1);
      expect(points?.[0]?.asInt, name).toBe(String(value));
      expect(points?.[0]?.timeUnixNano, name).toBe('1700000001000000000');
    }

    const sum = byName.get('argus.gc.count')?.sum;
    expect(sum?.aggregationTemporality).toBe(1);
    expect(sum?.isMonotonic).toBe(true);
    expect(sum?.dataPoints).toHaveLength(1);
    expect(sum?.dataPoints[0]?.asInt).toBe('7');
    expect(sum?.dataPoints[0]?.timeUnixNano).toBe('1700000001000000000');
    expect(sum?.dataPoints[0]?.startTimeUnixNano).toBe('1700000000000000000');
  });
});
