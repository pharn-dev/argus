export type BoundedQueue<T> = {
  /** Append an item. Returns true when the oldest item was evicted to make room. */
  push(item: T): boolean;
  shift(): T | undefined;
  readonly length: number;
};

/** Fixed-capacity drop-oldest FIFO backed by a ring buffer. */
export function createBoundedQueue<T>(capacity: number): BoundedQueue<T> {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError(`capacity must be a positive safe integer, got ${String(capacity)}`);
  }
  const slots: (T | undefined)[] = new Array<T | undefined>(capacity).fill(undefined);
  let head = 0;
  let length = 0;

  return {
    push(item: T): boolean {
      if (length === capacity) {
        slots[head] = item;
        head = (head + 1) % capacity;
        return true;
      }
      slots[(head + length) % capacity] = item;
      length += 1;
      return false;
    },
    shift(): T | undefined {
      if (length === 0) {
        return undefined;
      }
      const item = slots[head];
      slots[head] = undefined;
      head = (head + 1) % capacity;
      length -= 1;
      return item;
    },
    get length(): number {
      return length;
    },
  };
}
