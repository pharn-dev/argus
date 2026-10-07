import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type StackFrame = { url: string; line: number; column: number };

type WorkerPoolLike = { close: () => Promise<void> };

type SymbolizeModule = {
  createSymbolizationPool: (options?: { size?: number; taskTimeoutMs?: number }) => WorkerPoolLike;
  symbolizeStackFrames: (
    frames: readonly StackFrame[],
    options?: { pool?: WorkerPoolLike; timeoutMs?: number },
  ) => Promise<unknown>;
  WorkerPoolClosedError: abstract new (...args: never[]) => Error;
};

describe('analyzer stack symbolization pool routing and input checks', () => {
  it('AC-3: rejects with WorkerPoolClosedError, without a synchronous throw, when given a closed pool', async () => {
    const mod = (await import('./index.js')) as unknown as SymbolizeModule;
    const pool = mod.createSymbolizationPool();
    await pool.close();

    const frame: StackFrame = {
      url: pathToFileURL(join(tmpdir(), 'argus-symbolize-ac3-frame.js')).href,
      line: 1,
      column: 1,
    };

    let syncThrow: unknown = undefined;
    let pending: Promise<unknown> | undefined;
    try {
      pending = mod.symbolizeStackFrames([frame], { pool });
    } catch (error) {
      syncThrow = error;
    }

    expect(syncThrow).toBeUndefined();
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toBeInstanceOf(mod.WorkerPoolClosedError);
  }, 60_000);

  it('AC-3: rejects with TypeError, without a synchronous throw, when frames is not an array', async () => {
    const mod = (await import('./index.js')) as unknown as SymbolizeModule;

    let syncThrow: unknown = undefined;
    let pending: Promise<unknown> | undefined;
    try {
      pending = mod.symbolizeStackFrames('not an array' as never);
    } catch (error) {
      syncThrow = error;
    }

    expect(syncThrow).toBeUndefined();
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toBeInstanceOf(TypeError);
  }, 60_000);
});
