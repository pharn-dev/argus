import type { AggregatedWindow, CollectorListener } from '../collector/index.js';
import { toOtlpMetrics } from './otlp-metrics.js';
import { postOtlpJson, type OtlpTarget } from './otlp-transport.js';

export type OtlpMetricsExporterOptions = {
  url: string;
  headers?: Record<string, string>;
  serviceName?: string;
  timeoutMs?: number;
  queueCapacity?: number;
  onError?: (error: Error) => void;
};

export type OtlpMetricsExporter = {
  /** Queues one batch for export. Synchronous; never throws, never awaits. */
  export(windows: AggregatedWindow | readonly AggregatedWindow[]): void;
  /** Resolves once the queue is empty and nothing is in flight. Never rejects for an export failure. */
  flush(): Promise<void>;
  /** Stops accepting batches, then flushes. Idempotent. */
  close(): Promise<void>;
  readonly droppedBatches: number;
  readonly failedBatches: number;
  /** For `collector.subscribe(exporter.listener)`: one batch per window. */
  readonly listener: CollectorListener;
};

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_QUEUE_CAPACITY = 64;
const DEFAULT_SERVICE_NAME = 'argus';

function requirePositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer, got ${String(value)}`);
  }
}

function validate(options: OtlpMetricsExporterOptions): {
  target: OtlpTarget;
  serviceName: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch (cause) {
    throw new TypeError('url must be a valid http: or https: URL', { cause });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('url must use the http: or https: protocol');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  requirePositiveSafeInteger('timeoutMs', timeoutMs);
  requirePositiveSafeInteger('queueCapacity', options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY);
  const headers = options.headers ?? {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      throw new TypeError(`header ${name} must have a string value`);
    }
  }
  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
  if (typeof serviceName !== 'string' || serviceName.length === 0) {
    throw new TypeError('serviceName must be a non-empty string');
  }
  return {
    target: { url: options.url, origin: parsed.origin, headers: { ...headers }, timeoutMs },
    serviceName,
  };
}

export function createOtlpMetricsExporter(
  options: OtlpMetricsExporterOptions,
): OtlpMetricsExporter {
  const { target, serviceName } = validate(options);
  const queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
  const onError = options.onError;

  const queue: AggregatedWindow[][] = [];
  let closed = false;
  let droppedBatches = 0;
  let failedBatches = 0;
  let drain: Promise<void> | undefined;

  function report(error: Error): void {
    if (onError !== undefined) {
      try {
        onError(error);
        return;
      } catch {
        // The callback threw; fall through to the warning so the failure is never silent.
      }
    }
    process.emitWarning(error);
  }

  function fail(error: Error): void {
    failedBatches += 1;
    report(error);
  }

  async function sendBatch(batch: AggregatedWindow[]): Promise<void> {
    let body: string;
    try {
      body = JSON.stringify(toOtlpMetrics(batch, { serviceName }));
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error(String(cause)));
      return;
    }
    const error = await postOtlpJson(target, body);
    if (error !== undefined) fail(error);
  }

  async function drainQueue(): Promise<void> {
    try {
      for (let batch = queue.shift(); batch !== undefined; batch = queue.shift()) {
        try {
          await sendBatch(batch);
        } catch (cause) {
          fail(cause instanceof Error ? cause : new Error(String(cause)));
        }
      }
    } finally {
      drain = undefined;
    }
  }

  function exportBatch(windows: AggregatedWindow | readonly AggregatedWindow[]): void {
    const batch = Array.isArray(windows)
      ? [...(windows as readonly AggregatedWindow[])]
      : [windows as AggregatedWindow];
    if (batch.length === 0) return;
    if (closed || queue.length >= queueCapacity) {
      droppedBatches += 1;
      return;
    }
    queue.push(batch);
    drain ??= drainQueue();
  }

  async function flush(): Promise<void> {
    while (drain !== undefined) {
      await drain;
    }
  }

  async function close(): Promise<void> {
    closed = true;
    await flush();
  }

  const exporter: OtlpMetricsExporter = {
    export: exportBatch,
    flush,
    close,
    get droppedBatches() {
      return droppedBatches;
    },
    get failedBatches() {
      return failedBatches;
    },
    listener: {
      window: (window) => {
        exportBatch(window);
      },
    },
  };
  return exporter;
}
