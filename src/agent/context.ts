// The single importer of `node:async_hooks` in the agent (ARCHITECTURE.md).
import { AsyncLocalStorage } from 'node:async_hooks';
import { newTraceId } from './trace-id.js';

type TraceStore = { readonly traceId: string };

const storage = new AsyncLocalStorage<TraceStore>();

/** The trace id of the current async context, or undefined outside any trace. */
export function currentTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

/** Run `fn` inside a fresh trace context; async continuations of `fn` keep the same id. */
export function runWithTrace<T>(fn: () => T): T {
  return storage.run({ traceId: newTraceId() }, fn);
}

/**
 * Internal: run `fn` inside the trace `traceId` (HTTP tracer only). Scoped with `run`, never
 * `enterWith`: an entered context leaks into async resources that outlive the request (a
 * keep-alive socket's parser on Node 22), so a later request would inherit a stale trace.
 */
export function runInTrace<T>(traceId: string, fn: () => T): T {
  return storage.run({ traceId }, fn);
}
