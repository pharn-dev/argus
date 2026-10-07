/// <reference types="node" />
import { createBackpressureProbe, type BackpressureSample } from './backpressure-probe.js';
import { createEventLoopSampler, type EventLoopSample } from './event-loop-sampler.js';
import { createGcSampler, type GcSample } from './gc-sampler.js';
import { sampleHeapSpaces, type HeapSpaceSample } from './heap-space-sampler.js';
import { sampleMemory, type MemorySample } from './memory-sampler.js';

export type AgentSample = {
  /** Integer milliseconds since the epoch. */
  timestamp: number;
  eventLoop: EventLoopSample;
  memory: MemorySample;
  heapSpaces: HeapSpaceSample;
  gc: GcSample;
  backpressure: BackpressureSample;
};

export type SamplerController = {
  start(intervalMs: number): void;
  stop(): void;
};

export type SamplerControllerOptions = {
  /**
   * Called when a tick fails (taking a sample or `onSample` threw). The controller keeps ticking.
   * Defaults to a process warning (`ArgusSamplerWarning`) on the first failure of each run of
   * consecutive failures.
   */
  onError?: (error: unknown) => void;
};

function warn(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.emitWarning(`sampler tick failed: ${message}`, 'ArgusSamplerWarning');
}

export function createSamplerController(
  onSample: (sample: AgentSample) => void,
  options: SamplerControllerOptions = {},
): SamplerController {
  const { onError } = options;
  const eventLoop = createEventLoopSampler();
  const gc = createGcSampler();
  const backpressure = createBackpressureProbe();
  let timer: NodeJS.Timeout | undefined;
  let failing = false;

  const reportFailure = (error: unknown): void => {
    let unreported = error;
    if (onError !== undefined) {
      try {
        onError(error);
        return;
      } catch (handlerError) {
        unreported = handlerError;
      }
    }
    // Warn once per run of consecutive failures, so a tick that keeps failing does not flood stderr.
    if (!failing) {
      warn(unreported);
    }
  };

  // A tick never throws: an uncaught exception from a timer would take the host process down.
  const tick = (): void => {
    try {
      onSample({
        timestamp: Date.now(),
        eventLoop: eventLoop.sample(),
        memory: sampleMemory(),
        heapSpaces: sampleHeapSpaces(),
        gc: gc.sample(),
        backpressure: backpressure.sample(),
      });
      failing = false;
    } catch (error) {
      reportFailure(error);
      failing = true;
    }
  };

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
      failing = false;
      eventLoop.enable();
      gc.enable();
      backpressure.enable();
      timer = setInterval(tick, intervalMs);
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
