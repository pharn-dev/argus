/// <reference types="node" />
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** One window of event loop delay, all values integer nanoseconds. */
export type EventLoopSample = {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p99: number;
};

export type EventLoopSampler = {
  enable(): void;
  disable(): void;
  /** Read the current window, then reset so the next window starts fresh. */
  sample(): EventLoopSample;
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

export function createEventLoopSampler(): EventLoopSampler {
  const histogram = monitorEventLoopDelay();
  return {
    enable(): void {
      histogram.enable();
    },
    disable(): void {
      histogram.disable();
    },
    sample(): EventLoopSample {
      // An empty window reports a huge min sentinel and a NaN mean: emit zeros instead.
      const result: EventLoopSample =
        histogram.count === 0
          ? { min: 0, max: 0, mean: 0, p50: 0, p99: 0 }
          : {
              min: toNonNegativeInt(histogram.min),
              max: toNonNegativeInt(histogram.max),
              mean: toNonNegativeInt(histogram.mean),
              p50: toNonNegativeInt(histogram.percentile(50)),
              p99: toNonNegativeInt(histogram.percentile(99)),
            };
      histogram.reset();
      return result;
    },
  };
}
