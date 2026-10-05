import { open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { createRingBuffer } from './ring-buffer.js';
import type { AggregatedWindow } from './window.js';
import { parseWindowLine, serializeWindow } from './window-codec.js';

export type PersistOptions = { path: string; maxBytes: number };

export type WindowStore = {
  readonly path: string;
  readonly maxBytes: number;
  readonly skipped: number;
  readonly restored: number;
  readonly bytes: number;
  restore(): Promise<AggregatedWindow[]>;
  append(window: AggregatedWindow): Promise<void>;
  release(): Promise<void>;
};

export function createWindowStore(options: PersistOptions & { capacity: number }): WindowStore {
  const { path, maxBytes, capacity } = options;
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('persist.path must be a non-empty string');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('persist.maxBytes must be a positive safe integer');
  }
  const ring = createRingBuffer<AggregatedWindow>(capacity);
  const tmpPath = `${path}.compact.tmp`;
  let skipped = 0;
  let restored = 0;
  let bytes = 0;
  let needsNewline = false;
  let handle: FileHandle | undefined;
  let chain: Promise<void> = Promise.resolve();

  function enqueue(task: () => Promise<void>): Promise<void> {
    const next = chain.then(task);
    // Keep the chain usable after a failure; the caller still sees the rejection via `next`.
    chain = next.catch(() => undefined);
    return next;
  }

  async function closeHandle(): Promise<void> {
    const current = handle;
    handle = undefined;
    if (current !== undefined) {
      await current.close();
    }
  }

  async function compact(): Promise<void> {
    await closeHandle();
    const content = ring.snapshot().map(serializeWindow).join('');
    try {
      const tmp = await open(tmpPath, 'w');
      try {
        await tmp.writeFile(content);
        await tmp.datasync();
      } finally {
        await tmp.close();
      }
      await rename(tmpPath, path);
    } catch (error) {
      try {
        await rm(tmpPath, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'window compaction failed and its temp file could not be removed',
          { cause: cleanupError },
        );
      }
      throw error;
    }
    bytes = Buffer.byteLength(content);
    needsNewline = false;
  }

  return {
    path,
    maxBytes,
    get skipped(): number {
      return skipped;
    },
    get restored(): number {
      return restored;
    },
    get bytes(): number {
      return bytes;
    },
    async restore(): Promise<AggregatedWindow[]> {
      let data: Buffer;
      try {
        data = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return [];
        }
        throw error;
      }
      const lines = data.toString('utf8').split('\n');
      // The text after the last newline is empty, or a partial line left by a crash.
      const last = lines.pop() as string;
      if (last.length > 0) {
        lines.push(last);
        needsNewline = true;
      }
      for (const line of lines) {
        const window = parseWindowLine(line);
        if (window === undefined) {
          skipped += 1;
        } else {
          ring.push(window);
        }
      }
      bytes = data.length;
      const out = ring.snapshot();
      restored = out.length;
      return out;
    },
    append(window: AggregatedWindow): Promise<void> {
      return enqueue(async () => {
        handle ??= await open(path, 'a');
        const line = `${needsNewline ? '\n' : ''}${serializeWindow(window)}`;
        await handle.appendFile(line);
        needsNewline = false;
        bytes += Buffer.byteLength(line);
        ring.push(window);
        if (bytes > maxBytes) {
          await compact();
        }
      });
    },
    release(): Promise<void> {
      return enqueue(closeHandle);
    },
  };
}
