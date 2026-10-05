import type { AgentSample } from '../agent/index.js';

/** One closed aggregation window. Lag and stalls are nanoseconds, memory is bytes. All integers. */
export type AggregatedWindow = {
  start: number;
  end: number;
  count: number;
  late: number;
  eventLoop: { max: number; p99: number; mean: number };
  memory: { heapUsedLast: number; heapUsedMax: number; rssLast: number; rssMax: number };
  gc: { count: number; totalPause: number; maxPause: number };
  backpressure: { events: number; totalStall: number; maxStall: number };
};

/** The open, mutable state of a window while samples are still being added. */
export type WindowAccumulator = {
  start: number;
  count: number;
  late: number;
  eventLoopMax: number;
  eventLoopP99Max: number;
  eventLoopMeanSum: number;
  heapUsedLast: number;
  heapUsedMax: number;
  rssLast: number;
  rssMax: number;
  gcCount: number;
  gcTotalPause: number;
  gcMaxPause: number;
  bpEvents: number;
  bpTotalStall: number;
  bpMaxStall: number;
};

/** Truncate to an integer, clamp negatives and NaN to 0, cap at the largest safe integer. */
function toNonNegativeInt(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  const truncated = Math.trunc(value);
  if (truncated < 0) {
    return 0;
  }
  return truncated > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : truncated;
}

function saturatingAdd(a: number, b: number): number {
  return a > Number.MAX_SAFE_INTEGER - b ? Number.MAX_SAFE_INTEGER : a + b;
}

export function windowStartOf(timestamp: number, windowMs: number): number {
  return Math.floor(timestamp / windowMs) * windowMs;
}

export function openWindow(start: number): WindowAccumulator {
  return {
    start,
    count: 0,
    late: 0,
    eventLoopMax: 0,
    eventLoopP99Max: 0,
    eventLoopMeanSum: 0,
    heapUsedLast: 0,
    heapUsedMax: 0,
    rssLast: 0,
    rssMax: 0,
    gcCount: 0,
    gcTotalPause: 0,
    gcMaxPause: 0,
    bpEvents: 0,
    bpTotalStall: 0,
    bpMaxStall: 0,
  };
}

export function addSample(acc: WindowAccumulator, sample: AgentSample): void {
  const heapUsed = toNonNegativeInt(sample.memory.heapUsed);
  const rss = toNonNegativeInt(sample.memory.rss);
  acc.count = saturatingAdd(acc.count, 1);
  acc.eventLoopMax = Math.max(acc.eventLoopMax, toNonNegativeInt(sample.eventLoop.max));
  acc.eventLoopP99Max = Math.max(acc.eventLoopP99Max, toNonNegativeInt(sample.eventLoop.p99));
  acc.eventLoopMeanSum = saturatingAdd(
    acc.eventLoopMeanSum,
    toNonNegativeInt(sample.eventLoop.mean),
  );
  acc.heapUsedLast = heapUsed;
  acc.heapUsedMax = Math.max(acc.heapUsedMax, heapUsed);
  acc.rssLast = rss;
  acc.rssMax = Math.max(acc.rssMax, rss);
  acc.gcCount = saturatingAdd(acc.gcCount, toNonNegativeInt(sample.gc.count));
  acc.gcTotalPause = saturatingAdd(acc.gcTotalPause, toNonNegativeInt(sample.gc.totalPause));
  acc.gcMaxPause = Math.max(acc.gcMaxPause, toNonNegativeInt(sample.gc.maxPause));
  acc.bpEvents = saturatingAdd(acc.bpEvents, toNonNegativeInt(sample.backpressure.events));
  acc.bpTotalStall = saturatingAdd(
    acc.bpTotalStall,
    toNonNegativeInt(sample.backpressure.totalStall),
  );
  acc.bpMaxStall = Math.max(acc.bpMaxStall, toNonNegativeInt(sample.backpressure.maxStall));
}

export function closeWindow(acc: WindowAccumulator, windowMs: number): AggregatedWindow {
  return {
    start: acc.start,
    end: acc.start + windowMs,
    count: acc.count,
    late: acc.late,
    eventLoop: {
      max: acc.eventLoopMax,
      p99: acc.eventLoopP99Max,
      mean: acc.count === 0 ? 0 : Math.floor(acc.eventLoopMeanSum / acc.count),
    },
    memory: {
      heapUsedLast: acc.heapUsedLast,
      heapUsedMax: acc.heapUsedMax,
      rssLast: acc.rssLast,
      rssMax: acc.rssMax,
    },
    gc: { count: acc.gcCount, totalPause: acc.gcTotalPause, maxPause: acc.gcMaxPause },
    backpressure: { events: acc.bpEvents, totalStall: acc.bpTotalStall, maxStall: acc.bpMaxStall },
  };
}
