import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AgentSample } from '../agent/index.js';
import { createRingBuffer, type RingBuffer } from './ring-buffer.js';
import type { AggregatedWindow } from './window.js';
import { createWindowAggregator } from './window-aggregator.js';

export type CollectorOptions = { windowMs: number; capacity: number };

export type Collector = {
  readonly windows: RingBuffer<AggregatedWindow>;
  consume(source: Readable | AsyncIterable<AgentSample>): Promise<void>;
};

export function createCollector(options: CollectorOptions): Collector {
  const { windowMs, capacity } = options;
  // Validate eagerly; both factories throw RangeError on bad input.
  createWindowAggregator({ windowMs });
  const windows = createRingBuffer<AggregatedWindow>(capacity);

  return {
    windows,
    async consume(source: Readable | AsyncIterable<AgentSample>): Promise<void> {
      const aggregator = createWindowAggregator({ windowMs });
      await pipeline(source, aggregator, async function (closed: AsyncIterable<unknown>) {
        for await (const window of closed) {
          windows.push(window as AggregatedWindow);
        }
      });
    },
  };
}
