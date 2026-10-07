import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createBoundedFifo } from './bounded-fifo.js';
import { createSseClient } from './sse-client.js';

/** A response whose socket never drains until the test says so. */
function stalledResponse(): { res: ServerResponse; written: string[]; unblock(): void } {
  const emitter = new EventEmitter();
  const written: string[] = [];
  let accepting = false;
  const res = Object.assign(emitter, {
    write(chunk: string): boolean {
      written.push(chunk);
      return accepting;
    },
    end(): void {},
  }) as unknown as ServerResponse;
  return {
    res,
    written,
    unblock(): void {
      accepting = true;
      emitter.emit('drain');
    },
  };
}

describe('bounded FIFO', () => {
  it('keeps its backing array proportional to capacity when nobody ever shifts', () => {
    const fifo = createBoundedFifo<string>(100);
    let maxBacking = 0;
    for (let i = 0; i < 100_000; i += 1) {
      fifo.push(`event ${i}`);
      maxBacking = Math.max(maxBacking, fifo.backingLength);
    }
    expect(fifo.size).toBe(100);
    expect(maxBacking).toBeLessThanOrEqual(2 * 100 + 1);
  });

  it('is first-in first-out and reports each drop', () => {
    const fifo = createBoundedFifo<number>(3);
    expect([1, 2, 3, 4, 5].map((n) => fifo.push(n))).toEqual([false, false, false, true, true]);
    expect([fifo.shift(), fifo.shift(), fifo.shift(), fifo.shift()]).toEqual([3, 4, 5, undefined]);
    expect(fifo.backingLength).toBe(0);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => createBoundedFifo(0)).toThrow(RangeError);
  });
});

describe('SSE client with a stalled reader', () => {
  it('drops the oldest chunks, then delivers exactly the newest ones in order on drain', () => {
    const { res, written, unblock } = stalledResponse();
    let drops = 0;
    const client = createSseClient(res, { maxBufferedEvents: 10, onDrop: () => (drops += 1) });

    client.send('first'); // accepted by the socket, which now reports backpressure
    for (let i = 0; i < 50_000; i += 1) {
      client.send(`e${i}`);
    }
    expect(client.dropped).toBe(50_000 - 10);
    expect(drops).toBe(50_000 - 10);

    written.length = 0;
    unblock();
    expect(written).toEqual(Array.from({ length: 10 }, (_, k) => `e${50_000 - 10 + k}`));
    client.end();
  });
});
