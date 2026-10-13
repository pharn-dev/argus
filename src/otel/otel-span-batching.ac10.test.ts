import { describe, expect, it } from 'vitest';

type Exporter = { close(): Promise<void> };

type ExporterOptions = {
  url: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
  queueCapacity?: number;
};

type OtelModule = {
  createOtlpTraceExporter: (options: ExporterOptions) => Exporter;
  createOtlpMetricsExporter: (options: ExporterOptions) => Exporter;
};

const URL_UNDER_TEST = 'http://127.0.0.1:1/v1/traces';
const NEW_OPTIONS = ['flushIntervalMs', 'maxBatchSize', 'maxQueueSize'] as const;
const INVALID_VALUES = [0, -1, 1.5, Number.NaN];

/** Calls `create`; returns what it threw, or undefined after closing the exporter it returned. */
async function thrownBy(
  create: (options: ExporterOptions) => Exporter,
  options: ExporterOptions,
): Promise<unknown> {
  let exporter: Exporter;
  try {
    exporter = create(options);
  } catch (error) {
    return error;
  }
  await exporter.close();
  return undefined;
}

describe('otel span batching — AC-10', () => {
  it('AC-10: the three new options reject invalid values with a RangeError naming them, and queueCapacity keeps its validation', async () => {
    const otel = (await import('./index.js')) as unknown as OtelModule;
    const factories = [
      ['createOtlpTraceExporter', otel.createOtlpTraceExporter],
      ['createOtlpMetricsExporter', otel.createOtlpMetricsExporter],
    ] as const;

    const failures: string[] = [];
    for (const [factoryName, create] of factories) {
      for (const option of NEW_OPTIONS) {
        for (const value of INVALID_VALUES) {
          const thrown = await thrownBy(create, { url: URL_UNDER_TEST, [option]: value });
          if (!(thrown instanceof RangeError) || !thrown.message.includes(option)) {
            failures.push(
              `${factoryName}({ ${option}: ${String(value)} }) threw ${String(thrown)}`,
            );
          }
        }
      }

      const valid = await thrownBy(create, { url: URL_UNDER_TEST, queueCapacity: 64 });
      if (valid !== undefined) {
        failures.push(`${factoryName}({ queueCapacity: 64 }) threw ${String(valid)}`);
      }

      const zero = await thrownBy(create, { url: URL_UNDER_TEST, queueCapacity: 0 });
      if (!(zero instanceof RangeError) || !zero.message.includes('queueCapacity')) {
        failures.push(`${factoryName}({ queueCapacity: 0 }) threw ${String(zero)}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
