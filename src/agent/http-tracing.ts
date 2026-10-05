import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { enterTrace } from './context.js';
import { createSpanBuffer } from './span-buffer.js';
import type { SpanBuffer, SpanDrain } from './span-buffer.js';
import { newTraceId, parseTraceparent } from './trace-id.js';

export const DEFAULT_SPAN_BUFFER_SIZE = 1024;

export type HttpTracingOptions = { spanBufferSize?: number };

type Inflight = { traceId: string; startTimeMs: number; startNs: bigint };

const START_CHANNEL = 'http.server.request.start';
const FINISH_CHANNEL = 'http.server.response.finish';

let enabled = false;
let buffer: SpanBuffer = createSpanBuffer(DEFAULT_SPAN_BUFFER_SIZE);
const inflight = new WeakMap<object, Inflight>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function warn(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.emitWarning(`http tracing handler failed: ${message}`, 'ArgusTracingWarning');
}

function headerValue(headers: unknown): string | string[] | undefined {
  if (!isObject(headers)) {
    return undefined;
  }
  const value = headers.traceparent;
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return undefined;
}

function onStart(message: unknown): void {
  try {
    if (!isObject(message) || !isObject(message.request)) {
      return;
    }
    const request = message.request;
    const traceId = parseTraceparent(headerValue(request.headers)) ?? newTraceId();
    inflight.set(request, {
      traceId,
      startTimeMs: Date.now(),
      startNs: process.hrtime.bigint(),
    });
    enterTrace(traceId);
  } catch (error) {
    warn(error);
  }
}

function onFinish(message: unknown): void {
  try {
    if (!isObject(message) || !isObject(message.request) || !isObject(message.response)) {
      return;
    }
    const request = message.request;
    const entry = inflight.get(request);
    if (entry === undefined) {
      return;
    }
    inflight.delete(request);
    const url = typeof request.url === 'string' ? request.url : '';
    const queryAt = url.indexOf('?');
    const elapsed = Number(process.hrtime.bigint() - entry.startNs);
    buffer.push({
      traceId: entry.traceId,
      method: typeof request.method === 'string' ? request.method : '',
      path: queryAt === -1 ? url : url.slice(0, queryAt),
      statusCode: typeof message.response.statusCode === 'number' ? message.response.statusCode : 0,
      startTimeMs: entry.startTimeMs,
      durationNs: Math.min(Math.max(elapsed, 0), Number.MAX_SAFE_INTEGER),
    });
  } catch (error) {
    warn(error);
  }
}

/** Start tracing inbound HTTP requests. Idempotent: a second call while enabled is a no-op. */
export function enable(options: HttpTracingOptions = {}): void {
  if (enabled) {
    return;
  }
  const { spanBufferSize } = options;
  if (spanBufferSize !== undefined && spanBufferSize !== buffer.capacity) {
    buffer = createSpanBuffer(spanBufferSize);
  }
  subscribe(START_CHANNEL, onStart);
  subscribe(FINISH_CHANNEL, onFinish);
  enabled = true;
}

/** Stop tracing. Buffered spans are kept for `drainSpans()`. */
export function disable(): void {
  if (!enabled) {
    return;
  }
  unsubscribe(START_CHANNEL, onStart);
  unsubscribe(FINISH_CHANNEL, onFinish);
  enabled = false;
}

/** Return buffered spans (oldest first) and the number dropped since the previous drain. */
export function drainSpans(): SpanDrain {
  return buffer.drain();
}
