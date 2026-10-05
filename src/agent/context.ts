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

/** Internal: enter a trace for the rest of the current async execution (HTTP tracer only). */
export function enterTrace(traceId: string): void {
  storage.enterWith({ traceId });
}
