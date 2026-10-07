/// <reference types="node" />
import { Session } from 'node:inspector/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { aggregateAllocationProfile } from './allocation-profile.js';
import type { AllocationSite } from './allocation-profile.js';

export type AllocationSamplingOptions = {
  /** Average bytes between sampled allocations (V8 `samplingInterval`). */
  samplingInterval?: number;
  /** How long to sample, in milliseconds. */
  durationMs?: number;
  /** Maximum number of sites to return. */
  limit?: number;
};

/** V8's own default sampling interval, in bytes. */
export const DEFAULT_ALLOCATION_SAMPLING_INTERVAL = 32768;
export const DEFAULT_ALLOCATION_SAMPLING_DURATION_MS = 1000;
export const DEFAULT_ALLOCATION_SITE_LIMIT = 20;

/** Largest delay `setTimeout` honours; beyond it Node fires after 1 ms. */
const MAX_DURATION_MS = 2147483647;

let inProgress = false;

function positiveInteger(
  options: AllocationSamplingOptions,
  name: keyof AllocationSamplingOptions,
  fallback: number,
): number {
  const value: unknown = options[name];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`argus: sampleAllocations option ${name} must be a positive integer`);
  }
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sample allocations on the main isolate for `durationMs` using V8's sampling heap
 * profiler and return the top allocation sites, largest first. Only allocations still
 * live when sampling stops are reported. `line` is 1-based. Never throws synchronously:
 * every failure is a rejection. Only one sampling session may run at a time.
 */
export async function sampleAllocations(
  options: AllocationSamplingOptions = {},
): Promise<AllocationSite[]> {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('argus: sampleAllocations options must be an object');
  }
  const samplingInterval = positiveInteger(
    options,
    'samplingInterval',
    DEFAULT_ALLOCATION_SAMPLING_INTERVAL,
  );
  const durationMs = positiveInteger(
    options,
    'durationMs',
    DEFAULT_ALLOCATION_SAMPLING_DURATION_MS,
  );
  if (durationMs > MAX_DURATION_MS) {
    throw new TypeError(
      `argus: sampleAllocations option durationMs must not exceed ${MAX_DURATION_MS}`,
    );
  }
  const limit = positiveInteger(options, 'limit', DEFAULT_ALLOCATION_SITE_LIMIT);

  if (inProgress) {
    throw new Error('argus: an allocation sampling session is already in progress');
  }
  inProgress = true;
  try {
    const session = new Session();
    let connected = false;
    let enabled = false;
    let started = false;
    let stopped = false;
    let sites: AllocationSite[] = [];
    let failure: { error: unknown } | undefined;

    try {
      session.connect();
      connected = true;
      await session.post('HeapProfiler.enable');
      enabled = true;
      await session.post('HeapProfiler.startSampling', { samplingInterval });
      started = true;
      await sleep(durationMs);
      const { profile } = await session.post('HeapProfiler.stopSampling');
      stopped = true;
      sites = aggregateAllocationProfile(profile.head, limit);
    } catch (error) {
      failure = { error };
    }

    const cleanupErrors: string[] = [];
    let cleanupCause: unknown;
    const recordCleanup = (error: unknown): void => {
      cleanupErrors.push(describe(error));
      cleanupCause ??= error;
    };
    if (started && !stopped) {
      try {
        await session.post('HeapProfiler.stopSampling');
      } catch (error) {
        recordCleanup(error);
      }
    }
    if (enabled) {
      try {
        await session.post('HeapProfiler.disable');
      } catch (error) {
        recordCleanup(error);
      }
    }
    if (connected) {
      try {
        session.disconnect();
      } catch (error) {
        recordCleanup(error);
      }
    }

    const suffix =
      cleanupErrors.length > 0 ? `; cleanup also failed: ${cleanupErrors.join('; ')}` : '';
    if (failure !== undefined) {
      throw new Error(`argus: allocation sampling failed: ${describe(failure.error)}${suffix}`, {
        cause: failure.error,
      });
    }
    if (cleanupErrors.length > 0) {
      throw new Error(`argus: allocation sampling cleanup failed: ${cleanupErrors.join('; ')}`, {
        cause: cleanupCause,
      });
    }
    return sites;
  } finally {
    inProgress = false;
  }
}
