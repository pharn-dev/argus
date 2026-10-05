/// <reference types="node" />
import { createEventLoopSampler, type EventLoopSample } from './event-loop-sampler.js';
import { sampleMemory, type MemorySample } from './memory-sampler.js';

export type AgentSample = {
  /** Integer milliseconds since the epoch. */
  timestamp: number;
  eventLoop: EventLoopSample;
  memory: MemorySample;
};

export type SamplerController = {
  start(intervalMs: number): void;
  stop(): void;
};

export function createSamplerController(
  onSample: (sample: AgentSample) => void,
): SamplerController {
  const eventLoop = createEventLoopSampler();
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
      timer = setInterval(() => {
        onSample({ timestamp: Date.now(), eventLoop: eventLoop.sample(), memory: sampleMemory() });
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
    },
  };
}
