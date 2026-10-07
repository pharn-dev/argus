import type { OtlpTarget } from './otlp-transport.js';

/** Options shared by every OTLP/HTTP JSON exporter (metrics and traces). */
export type OtlpExporterOptions = {
  url: string;
  headers?: Record<string, string>;
  serviceName?: string;
  timeoutMs?: number;
  queueCapacity?: number;
  onError?: (error: Error) => void;
};

export type ResolvedOtlpExporterOptions = {
  target: OtlpTarget;
  serviceName: string;
  queueCapacity: number;
  onError: ((error: Error) => void) | undefined;
};

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_QUEUE_CAPACITY = 64;
const DEFAULT_SERVICE_NAME = 'argus';

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
  const queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
  requirePositiveSafeInteger('queueCapacity', queueCapacity);
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
    queueCapacity,
    onError: options.onError,
  };
}
