/// <reference types="node" />
import { createBackpressureProbe, type BackpressureSample } from './backpressure-probe.js';
import { createEventLoopSampler, type EventLoopSample } from './event-loop-sampler.js';
import { createGcSampler, type GcSample } from './gc-sampler.js';
import { sampleMemory, type MemorySample } from './memory-sampler.js';

export type AgentSample = {
  /** Integer milliseconds since the epoch. */
  timestamp: number;
  eventLoop: EventLoopSample;
  memory: MemorySample;
  gc: GcSample;
  backpressure: BackpressureSample;
};

export type SamplerController = {
  start(intervalMs: number): void;
  stop(): void;
};

export function createSamplerController(
  onSample: (sample: AgentSample) => void,
): SamplerController {
  const eventLoop = createEventLoopSampler();
  const gc = createGcSampler();
  const backpressure = createBackpressureProbe();
  let timer: NodeJS.Timeout | undefined;

  return {
    start(intervalMs: number): void {
      if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
        throw new RangeError(
          `intervalMs must be a positive safe integer, got ${String(intervalMs)}`,
        );
      }
      if (timer !== undefined) {
        return;
      }
      eventLoop.enable();
      gc.enable();
      backpressure.enable();
      timer = setInterval(() => {
        onSample({
          timestamp: Date.now(),
          eventLoop: eventLoop.sample(),
          memory: sampleMemory(),
          gc: gc.sample(),
          backpressure: backpressure.sample(),
        });
      }, intervalMs);
      timer.unref();
    },
    stop(): void {
      if (timer === undefined) {
        return;
      }
      clearInterval(timer);
      timer = undefined;
      eventLoop.disable();
      gc.disable();
      backpressure.disable();
    },
  };
}
