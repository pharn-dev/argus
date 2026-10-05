import type { ServerResponse } from 'node:http';
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
  let queue: string[] = [];
  let head = 0;
  let blocked = false;
  let ended = false;
  let dropped = 0;

  const flush = (): void => {
    while (head < queue.length) {
      const chunk = queue[head] as string;
      head += 1;
      if (!res.write(chunk)) {
        blocked = true;
        break;
      }
    }
    if (head >= queue.length) {
      queue = [];
      head = 0;
    } else if (head > queue.length / 2) {
      queue = queue.slice(head);
      head = 0;
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
      queue.push(chunk);
      if (queue.length - head > options.maxBufferedEvents) {
        head += 1;
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
      queue = [];
      head = 0;
      res.end();
    },
  };
}
