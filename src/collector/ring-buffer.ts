export type RingBuffer<T> = {
  readonly capacity: number;
  push(item: T): void;
  /** A fresh array, oldest first, newest last. */
  snapshot(): T[];
  size(): number;
};

export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError('capacity must be a positive safe integer');
  }
  const slots: Array<T | undefined> = new Array<T | undefined>(capacity).fill(undefined);
  let head = 0; // index of the oldest item
  let size = 0;

  return {
    capacity,
    push(item: T): void {
      if (size < capacity) {
        slots[(head + size) % capacity] = item;
        size += 1;
        return;
      }
      slots[head] = item;
      head = (head + 1) % capacity;
    },
    snapshot(): T[] {
      const out: T[] = [];
      for (let i = 0; i < size; i += 1) {
        out.push(slots[(head + i) % capacity] as T);
      }
      return out;
    },
    size(): number {
      return size;
    },
  };
}
