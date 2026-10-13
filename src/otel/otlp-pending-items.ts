/**
 * One export call (a listener callback or an `export()` invocation). Every item of the call shares
 * the same object, so a call whose items are partly or wholly dropped is counted as one dropped
 * batch, once.
 */
export type ExportCall = { dropped: boolean };

export type PendingEntry<T> = { readonly item: T; readonly call: ExportCall };

export type PendingItems<T> = {
  /**
   * Appends `entry` as the newest. When the ring already holds `capacity` entries, the OLDEST entry
   * is evicted to make room and returned; otherwise returns `undefined`. O(1).
   */
  push(entry: PendingEntry<T>): PendingEntry<T> | undefined;
  /** Removes and returns up to `count` of the oldest entries, oldest first. */
  take(count: number): PendingEntry<T>[];
  /** Removes and returns every entry, oldest first. */
  clear(): PendingEntry<T>[];
  readonly size: number;
};

/** The ring starts small and doubles on demand, so a huge `capacity` costs nothing until used. */
const INITIAL_SLOTS = 16;

/**
 * A fixed-capacity FIFO ring that drops its oldest entry when full. A head index and modulo
 * arithmetic keep every operation off `Array.prototype.shift`. A pure data structure: no timers, no
 * I/O, no counters.
 */
export function createPendingItems<T>(capacity: number): PendingItems<T> {
  let slots: (PendingEntry<T> | undefined)[] = new Array<PendingEntry<T> | undefined>(
    Math.min(capacity, INITIAL_SLOTS),
  );
  let head = 0;
  let size = 0;

  function grow(): void {
    const next = new Array<PendingEntry<T> | undefined>(Math.min(capacity, slots.length * 2));
    for (let offset = 0; offset < size; offset += 1) {
      next[offset] = slots[(head + offset) % slots.length];
    }
    slots = next;
    head = 0;
  }

  function push(entry: PendingEntry<T>): PendingEntry<T> | undefined {
    if (size === capacity) {
      // Full: `slots.length` equals `capacity`, so the oldest entry's slot is reused by the newest.
      const evicted = slots[head];
      slots[head] = entry;
      head = (head + 1) % slots.length;
      return evicted;
    }
    if (size === slots.length) grow();
    slots[(head + size) % slots.length] = entry;
    size += 1;
    return undefined;
  }

  function take(count: number): PendingEntry<T>[] {
    const taken: PendingEntry<T>[] = [];
    const wanted = Math.min(count, size);
    for (let index = 0; index < wanted; index += 1) {
      const entry = slots[head];
      slots[head] = undefined;
      head = (head + 1) % slots.length;
      size -= 1;
      if (entry !== undefined) taken.push(entry);
    }
    if (size === 0) head = 0;
    return taken;
  }

  return {
    push,
    take,
    clear: () => take(size),
    get size() {
      return size;
    },
  };
}
