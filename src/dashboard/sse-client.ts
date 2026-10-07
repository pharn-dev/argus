import type { ServerResponse } from 'node:http';
import { createBoundedFifo } from './bounded-fifo.js';
import { HEARTBEAT } from './sse-format.js';

export type SseClientOptions = {
  maxBufferedEvents: number;
  onDrop(): void;
};

export type SseClient = {
  send(chunk: string): void;
  heartbeat(): void;
  readonly dropped: number;
  end(): void;
};

/** One SSE response with bounded pending output: the oldest chunk is dropped on overflow. */
export function createSseClient(res: ServerResponse, options: SseClientOptions): SseClient {
  // Bounded in memory, not just in count: dropped chunks are released even if the client never
  // drains (a stalled reader would otherwise pin every event ever sent to it).
  const queue = createBoundedFifo<string>(options.maxBufferedEvents);
  let blocked = false;
  let ended = false;
  let dropped = 0;

  const flush = (): void => {
    for (let chunk = queue.shift(); chunk !== undefined; chunk = queue.shift()) {
      if (!res.write(chunk)) {
        blocked = true;
        break;
      }
    }
  };

  const onDrain = (): void => {
    if (ended) {
      return;
    }
    blocked = false;
    flush();
  };
  res.on('drain', onDrain);

  return {
    send(chunk: string): void {
      if (ended) {
        return;
      }
      if (!blocked) {
        if (!res.write(chunk)) {
          blocked = true;
        }
        return;
      }
      if (queue.push(chunk)) {
        dropped += 1;
        options.onDrop();
      }
    },
    heartbeat(): void {
      if (ended || blocked) {
        return;
      }
      if (!res.write(HEARTBEAT)) {
        blocked = true;
      }
    },
    get dropped(): number {
      return dropped;
    },
    end(): void {
      if (ended) {
        return;
      }
      ended = true;
      res.off('drain', onDrain);
      queue.clear();
      res.end();
    },
  };
}
