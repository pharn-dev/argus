import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { Server as HttpServer } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import { runInTrace } from './context.js';
import { createSpanBuffer } from './span-buffer.js';
import type { SpanBuffer, SpanDrain } from './span-buffer.js';
import { newSpanId, newTraceId, parseTraceparent } from './trace-id.js';

export const DEFAULT_SPAN_BUFFER_SIZE = 1024;

export type HttpTracingOptions = { spanBufferSize?: number };

type Inflight = { traceId: string; spanId: string; startTimeMs: number; startNs: bigint };

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
      spanId: newSpanId(),
      startTimeMs: Date.now(),
      startNs: process.hrtime.bigint(),
    });
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
    const method = typeof request.method === 'string' ? request.method : '';
    const path = queryAt === -1 ? url : url.slice(0, queryAt);
    buffer.push({
      traceId: entry.traceId,
      spanId: entry.spanId,
      name: `${method} ${path}`,
      method,
      path,
      statusCode: typeof message.response.statusCode === 'number' ? message.response.statusCode : 0,
      startTimeMs: entry.startTimeMs,
      durationNs: Math.min(Math.max(elapsed, 0), Number.MAX_SAFE_INTEGER),
    });
  } catch (error) {
    warn(error);
  }
}

// ---- Shared `emit` wrap ----------------------------------------------------------------------
//
// Each server's 'request' listeners run inside the trace the start channel assigned to that
// request. The start channel publishes synchronously right before `emit('request', …)`, so the
// request is already in `inflight` when the wrapper runs. `runInTrace` scopes the context to the
// listeners and their async continuations only — nothing created earlier (a keep-alive socket)
// inherits it.
//
// Safety rules, the same as the backpressure probe's `write` wrappers:
//   - Each install captures its originals in a per-install record. Uninstalling marks the record
//     inactive, which turns its wrapper into a transparent pass-through, so a wrapper someone
//     stacked on top keeps working.
//   - `emit` is restored only while the prototype still holds our wrapper (identity guard).
//   - The install lives on `globalThis` under a `Symbol.for` key. A second copy of Argus (ESM + CJS)
//     adds its own contributor (its own `inflight` map and trace context) to the existing wrapper
//     instead of wrapping `emit` again.

type Emit = (this: unknown, event: string | symbol, ...args: unknown[]) => boolean;
/** Shared by every Argus copy that uses the v1 registry; change `EMIT_REGISTRY_KEY` if it changes. */
type Contributor = (request: object, next: () => boolean) => boolean;
type EmitPatch = {
  readonly proto: object;
  readonly own: PropertyDescriptor | undefined;
  readonly original: Emit;
  wrapper: Emit | undefined;
  active: boolean;
};
type EmitSession = { readonly patches: EmitPatch[] };
type EmitRegistry = { readonly contributors: Set<Contributor>; session: EmitSession | undefined };

const EMIT_REGISTRY_KEY = Symbol.for('argus.http-tracing.emit.v1');
/** Set on every wrapper; points at its install record so a later install can skip a dead layer. */
const EMIT_WRAPPER_KEY = Symbol.for('argus.http-tracing.emit');
const MAX_PEEL = 64;

function isEmitRegistry(value: unknown): value is EmitRegistry {
  return isObject(value) && value.contributors instanceof Set && Object.hasOwn(value, 'session');
}

const emitRegistry: EmitRegistry = (() => {
  const host = globalThis as unknown as Record<symbol, unknown>;
  const existing = host[EMIT_REGISTRY_KEY];
  if (isEmitRegistry(existing)) {
    return existing;
  }
  const created: EmitRegistry = { contributors: new Set(), session: undefined };
  if (existing === undefined) {
    Object.defineProperty(host, EMIT_REGISTRY_KEY, { value: created, configurable: true });
  }
  return created;
})();

/** This copy's part of a traced 'request' emit: its own `inflight` entry and trace context. */
const contribute: Contributor = (request, next) => {
  const entry = inflight.get(request);
  return entry === undefined ? next() : runInTrace(entry.traceId, next);
};

function createEmitWrapper(patch: EmitPatch): Emit {
  const original = patch.original;
  // The named parameter keeps `wrapper.length` at EventEmitter#emit's arity; `arguments` forwards
  // exactly what the caller passed.
  const wrapper = function emit(this: unknown, event: string | symbol): boolean {
    // eslint-disable-next-line prefer-rest-params -- see above
    const args = arguments;
    const request: unknown = args[1];
    if (
      event !== 'request' ||
      !patch.active ||
      emitRegistry.contributors.size === 0 ||
      !isObject(request)
    ) {
      return Reflect.apply(original, this, args) as boolean;
    }
    let call = (): boolean => Reflect.apply(original, this, args) as boolean;
    for (const contributor of emitRegistry.contributors) {
      const next = call;
      call = () => contributor(request, next);
    }
    return call();
  };
  Object.defineProperty(wrapper, 'length', { value: original.length, configurable: true });
  Object.defineProperty(wrapper, EMIT_WRAPPER_KEY, { value: patch });
  return wrapper;
}

type DeadRecord = { active: false; original: Emit; own: PropertyDescriptor | undefined };

function deadRecordOf(value: unknown): DeadRecord | undefined {
  if (typeof value !== 'function') {
    return undefined;
  }
  const record = (value as unknown as Record<symbol, unknown>)[EMIT_WRAPPER_KEY];
  if (isObject(record) && record.active === false && typeof record.original === 'function') {
    return record as DeadRecord;
  }
  return undefined;
}

function patchEmit(session: EmitSession, proto: object): void {
  try {
    let own = Object.getOwnPropertyDescriptor(proto, 'emit');
    let original = (proto as { emit: Emit }).emit;
    // Skip inactive Argus wrappers left on top (a third party restored one of them).
    for (let i = 0; i < MAX_PEEL; i += 1) {
      const dead = own === undefined ? undefined : deadRecordOf(own.value);
      if (dead === undefined) {
        break;
      }
      own = dead.own;
      original = dead.original;
    }
    const patch: EmitPatch = { proto, own, original, wrapper: undefined, active: true };
    const wrapper = createEmitWrapper(patch);
    patch.wrapper = wrapper;
    Object.defineProperty(proto, 'emit', {
      value: wrapper,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    session.patches.push(patch);
  } catch (error) {
    // A frozen prototype cannot be patched; requests on it are still timed, just not context-scoped.
    warn(error);
  }
}

function installEmits(): void {
  if (emitRegistry.session !== undefined) {
    return;
  }
  const session: EmitSession = { patches: [] };
  emitRegistry.session = session;
  patchEmit(session, HttpServer.prototype);
  patchEmit(session, HttpsServer.prototype);
}

function restoreEmits(): void {
  const session = emitRegistry.session;
  if (session === undefined) {
    return;
  }
  emitRegistry.session = undefined;
  for (const patch of session.patches) {
    // From here on the wrapper is a pass-through to `patch.original`, wherever it still sits.
    patch.active = false;
    try {
      // Never clobber a wrapper someone else installed after ours.
      if (Object.getOwnPropertyDescriptor(patch.proto, 'emit')?.value !== patch.wrapper) {
        continue;
      }
      if (patch.own === undefined) {
        delete (patch.proto as { emit?: Emit }).emit;
      } else {
        Object.defineProperty(patch.proto, 'emit', patch.own);
      }
    } catch (error) {
      warn(error);
    }
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
  emitRegistry.contributors.add(contribute);
  installEmits();
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
  emitRegistry.contributors.delete(contribute);
  if (emitRegistry.contributors.size === 0) {
    restoreEmits();
  }
  enabled = false;
}

/** Return buffered spans (oldest first) and the number dropped since the previous drain. */
export function drainSpans(): SpanDrain {
  return buffer.drain();
}
