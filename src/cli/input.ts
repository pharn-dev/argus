import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { ServeInput } from './args.js';

export type OpenedInput = {
  /** Where the bytes come from; `process.stdin` is touched only on first access. */
  readonly stream: Readable;
  /** Releases the file handle; a no-op for stdin. */
  close(): Promise<void>;
};

/**
 * Opens the input before anything binds, so an unreadable file fails early and by name.
 * A file is read through a handle's own stream (closed with it); stdin is resolved lazily.
 */
export async function openInput(
  input: ServeInput,
  stdin: () => Readable = () => process.stdin,
): Promise<OpenedInput> {
  if (input.kind === 'stdin') {
    return {
      get stream(): Readable {
        return stdin();
      },
      close: () => Promise.resolve(),
    };
  }
  let handle;
  try {
    handle = await open(input.path, 'r');
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    throw new Error(`cannot read input file "${input.path}": ${reason}`, { cause: error });
  }
  const stream = handle.createReadStream();
  return {
    stream,
    async close(): Promise<void> {
      stream.destroy();
      await handle.close().catch((error: NodeJS.ErrnoException) => {
        // The stream closes the handle on destroy; only a different failure is worth reporting.
        if (error.code !== 'EBADF') {
          throw error;
        }
      });
    },
  };
}
