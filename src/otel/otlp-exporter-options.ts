import type { OtlpTarget } from './otlp-transport.js';

/** Options shared by every OTLP/HTTP JSON exporter (metrics and traces). */
export type OtlpExporterOptions = {
  url: string;
  headers?: Record<string, string>;
  serviceName?: string;
  timeoutMs?: number;
  /**
   * @deprecated No longer bounds anything: the queue holds items, not batches. Still accepted and
   * validated (a positive safe integer) so existing configuration keeps working; use
   * `maxQueueSize`, which is counted in items, instead.
   */
  queueCapacity?: number;
  /**
   * How long the oldest pending items wait for a full batch before they are sent anyway, in
   * milliseconds. Defaults to 1000.
   */
  flushIntervalMs?: number;
  /** Most items sent in one request. Defaults to 512. */
  maxBatchSize?: number;
  /**
   * Most items held pending behind the request in flight; when full, the OLDEST pending item is
   * dropped, counted and reported. Defaults to 2048.
   */
  maxQueueSize?: number;
  /**
   * How long `close()` waits for pending items before dropping them and aborting the request in
   * flight. Defaults to `timeoutMs`.
   */
  closeTimeoutMs?: number;
  onError?: (error: Error) => void;
};

export type ResolvedOtlpExporterOptions = {
  target: OtlpTarget;
  serviceName: string;
  flushIntervalMs: number;
  maxBatchSize: number;
  maxQueueSize: number;
  closeTimeoutMs: number;
  onError: ((error: Error) => void) | undefined;
};

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_MAX_BATCH_SIZE = 512;
const DEFAULT_MAX_QUEUE_SIZE = 2048;
const DEFAULT_SERVICE_NAME = 'phargus';

function requirePositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer, got ${String(value)}`);
  }
}

/** Validates the options and applies the defaults. Throws a TypeError or RangeError on bad input. */
export function resolveOtlpExporterOptions(
  options: OtlpExporterOptions,
): ResolvedOtlpExporterOptions {
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
  // Deprecated and otherwise ignored, but an invalid value is still rejected as before.
  if (options.queueCapacity !== undefined) {
    requirePositiveSafeInteger('queueCapacity', options.queueCapacity);
  }
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  requirePositiveSafeInteger('flushIntervalMs', flushIntervalMs);
  const maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  requirePositiveSafeInteger('maxBatchSize', maxBatchSize);
  const maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  requirePositiveSafeInteger('maxQueueSize', maxQueueSize);
  const closeTimeoutMs = options.closeTimeoutMs ?? timeoutMs;
  if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 0) {
    throw new RangeError(
      `closeTimeoutMs must be a non-negative safe integer, got ${String(closeTimeoutMs)}`,
    );
  }
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
    flushIntervalMs,
    maxBatchSize,
    maxQueueSize,
    closeTimeoutMs,
    onError: options.onError,
  };
}
