/**
 * A FIFO of at most `capacity` items that drops its oldest item on overflow. Shifted and dropped
 * slots are released as they go, and the backing array is compacted once its dead prefix outgrows
 * the live part, so memory stays proportional to `capacity` whether or not anyone ever shifts.
 */
export type BoundedFifo<T> = {
  /** Append an item; returns true when the oldest item was dropped to make room. */
  push(item: T): boolean;
  /** Remove and return the oldest item, or `undefined` when empty. */
  shift(): T | undefined;
  /** Drop every item. */
  clear(): void;
  /** Number of live items. */
  readonly size: number;
  /** Length of the backing array (live items plus not-yet-compacted dead slots). For tests. */
  readonly backingLength: number;
};

export function createBoundedFifo<T>(capacity: number): BoundedFifo<T> {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`capacity must be a positive integer, got ${String(capacity)}`);
  }
  let items: (T | undefined)[] = [];
  let head = 0;

  const advance = (): T | undefined => {
    const item = items[head];
    items[head] = undefined;
    head += 1;
    if (head >= items.length) {
      items = [];
      head = 0;
    } else if (head > items.length - head) {
      items = items.slice(head);
      head = 0;
    }
    return item;
  };

  return {
    push(item: T): boolean {
      items.push(item);
      if (items.length - head > capacity) {
        advance();
        return true;
      }
      return false;
    },
    shift(): T | undefined {
      return head < items.length ? advance() : undefined;
    },
    clear(): void {
      items = [];
      head = 0;
    },
    get size(): number {
      return items.length - head;
    },
    get backingLength(): number {
      return items.length;
    },
  };
}
