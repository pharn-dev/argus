import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type AlertRuleInput = {
  id: string;
  metric: string;
  comparison: string;
  threshold: number;
  forWindows?: number;
};

type AlertOutput = {
  ruleId: string;
  state: string;
  windowStart: number;
  observed: number;
};

type CollectorUnderTest = {
  readonly windows: { snapshot(): Array<{ start: number }> };
  readonly alerts: { snapshot(): AlertOutput[] };
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: {
    windowMs: number;
    capacity: number;
    alerts?: readonly AlertRuleInput[];
  }) => CollectorUnderTest;
};

/** A full AgentSample-shaped object at the given timestamp with the given event-loop max. */
function makeSample(timestamp: number, eventLoopMax: number): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: eventLoopMax, mean: 10, p50: 9, p99: 18 },
    memory: { heapUsed: 100, heapTotal: 200, rss: 1000, external: 0, arrayBuffers: 0 },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  };
}

const rules: AlertRuleInput[] = [
  { id: 'loop-max', metric: 'eventLoop.max', comparison: '>', threshold: 100 },
];

describe('collector alerts — AC-3', () => {
  it('AC-3: a collector with an alert rule records windows and firing/resolved alerts, and rejects with a source error', async () => {
    const collectorModule = (await import('./index.js')) as unknown as CollectorModule;

    const collector = collectorModule.createCollector({
      windowMs: 1000,
      capacity: 10,
      alerts: rules,
    });
    const source = Readable.from([
      makeSample(100, 50),
      makeSample(500, 40),
      makeSample(1100, 500),
      makeSample(1600, 300),
      makeSample(2100, 50),
      makeSample(2700, 20),
    ]);
    await expect(collector.consume(source)).resolves.toBeUndefined();

    expect(collector.windows.snapshot().map((window) => window.start)).toEqual([0, 1000, 2000]);

    const alerts = collector.alerts.snapshot();
    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert) => [alert.ruleId, alert.state, alert.windowStart])).toEqual([
      ['loop-max', 'firing', 1000],
      ['loop-max', 'resolved', 2000],
    ]);
    expect(alerts.map((alert) => alert.observed)).toEqual([500, 50]);

    const failing = collectorModule.createCollector({
      windowMs: 1000,
      capacity: 10,
      alerts: rules,
    });
    const sourceError = new Error('source failed');
    let emitted = false;
    const erroringSource = new Readable({
      objectMode: true,
      read() {
        if (!emitted) {
          emitted = true;
          this.push(makeSample(100, 500));
          return;
        }
        this.destroy(sourceError);
      },
    });
    await expect(failing.consume(erroringSource)).rejects.toBe(sourceError);
  }, 10_000);
});
