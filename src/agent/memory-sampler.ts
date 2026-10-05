/// <reference types="node" />
import process from 'node:process';

/** Process memory, all values integer bytes. */
export type MemorySample = {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
};

export function sampleMemory(): MemorySample {
  const usage = process.memoryUsage();
  return {
    heapUsed: Math.trunc(usage.heapUsed),
    heapTotal: Math.trunc(usage.heapTotal),
    rss: Math.trunc(usage.rss),
    external: Math.trunc(usage.external),
    arrayBuffers: Math.trunc(usage.arrayBuffers),
  };
}
