import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

type TraceContextApi = {
  currentTraceId(): string | undefined;
  runWithTrace<T>(fn: () => T): T;
};

const TRACE_ID = /^[0-9a-f]{32}$/;

async function loadApi(): Promise<TraceContextApi> {
  const mod = (await import('./index.js')) as unknown as Partial<TraceContextApi>;
  if (typeof mod.currentTraceId !== 'function' || typeof mod.runWithTrace !== 'function') {
    throw new Error('currentTraceId / runWithTrace are not exported from src/agent/index.ts');
  }
  return mod as TraceContextApi;
}

/** Reads the trace id at every async boundary the AC names, all inside one trace. */
async function readAll(api: TraceContextApi): Promise<(string | undefined)[]> {
  const reads: (string | undefined)[] = [];
  reads.push(api.currentTraceId());

  await delay(1);
  reads.push(api.currentTraceId());

  reads.push(
    await new Promise<string | undefined>((resolve) => {
      setTimeout(() => resolve(api.currentTraceId()), 1);
    }),
  );

  reads.push(
    await Promise.resolve()
      .then(() => 1)
      .then(() => api.currentTraceId()),
  );

  const emitter = new EventEmitter();
  reads.push(
    await new Promise<string | undefined>((resolve) => {
      emitter.once('tick', () => resolve(api.currentTraceId()));
      setImmediate(() => emitter.emit('tick'));
    }),
  );

  return reads;
}

describe('agent trace context — AC-1', () => {
  it('AC-1: currentTraceId is undefined outside a trace and stable within each runWithTrace, distinct across runs', async () => {
    const api = await loadApi();

    expect(api.currentTraceId()).toBeUndefined();

    const first = await api.runWithTrace(() => readAll(api));
    const second = await api.runWithTrace(() => readAll(api));

    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);

    const firstId = first[0];
    const secondId = second[0];
    expect(firstId).toMatch(TRACE_ID);
    expect(secondId).toMatch(TRACE_ID);
    for (const id of first) expect(id).toBe(firstId);
    for (const id of second) expect(id).toBe(secondId);
    expect(firstId).not.toBe(secondId);

    expect(api.currentTraceId()).toBeUndefined();
  });
});
