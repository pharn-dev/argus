/// <reference types="node" />
import { constants, PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks';

/** One window of garbage collection activity. Pauses are integer nanoseconds, the rest integer counts. */
export type GcSample = {
  count: number;
  totalPause: number;
  maxPause: number;
  kinds: { minor: number; major: number; incremental: number; weakcb: number };
};

export type GcSampler = {
  enable(): void;
  disable(): void;
  /** Read the current window, then reset so the next window starts fresh. */
  sample(): GcSample;
};

function toNonNegativeInt(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  const rounded = Math.round(value);
  if (rounded < 0) {
    return 0;
  }
  return rounded > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : rounded;
}

function emptyWindow(): GcSample {
  return {
    count: 0,
    totalPause: 0,
    maxPause: 0,
    kinds: { minor: 0, major: 0, incremental: 0, weakcb: 0 },
  };
}

/** Narrow the loosely typed entry detail to its numeric GC kind, if it has one. */
function readKind(entry: PerformanceEntry): number | undefined {
  // @types/node does not declare `detail` on PerformanceEntry; narrow from unknown instead of using any.
  const candidate: unknown = entry;
  if (typeof candidate !== 'object' || candidate === null || !('detail' in candidate)) {
    return undefined;
  }
  const detail: unknown = candidate.detail;
  if (typeof detail === 'object' && detail !== null && 'kind' in detail) {
    const kind: unknown = detail.kind;
    return typeof kind === 'number' ? kind : undefined;
  }
  return undefined;
}

export function createGcSampler(): GcSampler {
  let window = emptyWindow();

  const fold = (entry: PerformanceEntry): void => {
    const pauseNs = toNonNegativeInt(entry.duration * 1_000_000);
    window.count = Math.min(window.count + 1, Number.MAX_SAFE_INTEGER);
    window.totalPause = Math.min(window.totalPause + pauseNs, Number.MAX_SAFE_INTEGER);
    window.maxPause = Math.max(window.maxPause, pauseNs);
    const kind = readKind(entry);
    if (kind === constants.NODE_PERFORMANCE_GC_MINOR) {
      window.kinds.minor += 1;
    } else if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) {
      window.kinds.major += 1;
    } else if (kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL) {
      window.kinds.incremental += 1;
    } else if (kind === constants.NODE_PERFORMANCE_GC_WEAKCB) {
      window.kinds.weakcb += 1;
    }
  };

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      fold(entry);
    }
  });
  let enabled = false;

  return {
    enable(): void {
      if (enabled) {
        return;
      }
      enabled = true;
      window = emptyWindow();
      observer.observe({ entryTypes: ['gc'] });
    },
    disable(): void {
      if (!enabled) {
        return;
      }
      enabled = false;
      observer.disconnect();
    },
    sample(): GcSample {
      if (enabled) {
        for (const entry of observer.takeRecords()) {
          fold(entry);
        }
      }
      const result = window;
      window = emptyWindow();
      return result;
    },
  };
}
