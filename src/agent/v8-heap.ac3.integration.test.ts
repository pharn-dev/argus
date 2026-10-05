import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined) continue;
    try {
      chmodSync(dir, 0o700);
    } catch {
      // The directory may already be gone; rmSync below reports nothing for a missing path.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `argus-v8-heap-ac3-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

function snapshotFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.heapsnapshot'));
}

/** Calls fn and records whether it threw synchronously; returns what it returned. */
function callWithoutThrow(fn: () => unknown): unknown {
  let returned: unknown;
  expect(() => {
    returned = fn();
  }, 'the call does not throw synchronously').not.toThrow();
  expect(returned, 'the call returns a promise').toBeInstanceOf(Promise);
  return returned;
}

async function rejectionOf(promise: unknown): Promise<unknown> {
  try {
    await (promise as Promise<unknown>);
  } catch (err: unknown) {
    return err;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('agent on-demand heap snapshot refusals — AC-3', () => {
  it('AC-3: a missing directory rejects with an Error naming the directory and leaves no .heapsnapshot file', async () => {
    const { takeHeapSnapshot } = await import('./index.js');
    const parent = makeTempDir('missing');
    const missing = join(parent, 'does-not-exist');

    const promise = callWithoutThrow(() => takeHeapSnapshot({ dir: missing }));
    const err = await rejectionOf(promise);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(missing);
    expect(existsSync(missing), 'the missing directory was not created').toBe(false);
    expect(snapshotFilesIn(parent), 'no .heapsnapshot file left behind').toEqual([]);
  }, 60_000);

  it('AC-3: a non-writable directory rejects with an Error naming the directory and leaves no .heapsnapshot file', async () => {
    const { takeHeapSnapshot } = await import('./index.js');
    const dir = makeTempDir('readonly');
    chmodSync(dir, 0o500);

    const promise = callWithoutThrow(() => takeHeapSnapshot({ dir }));
    const err = await rejectionOf(promise);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(dir);
    expect(snapshotFilesIn(dir), 'no .heapsnapshot file left behind').toEqual([]);
  }, 60_000);

  it('AC-3: of two same-tick calls the first resolves with a snapshot and the second rejects as already in progress', async () => {
    const { takeHeapSnapshot } = await import('./index.js');
    const dir = makeTempDir('same-tick');

    const firstPromise = callWithoutThrow(() => takeHeapSnapshot({ dir }));
    const secondPromise = callWithoutThrow(() => takeHeapSnapshot({ dir }));

    const [first, second] = await Promise.allSettled([
      firstPromise as Promise<unknown>,
      secondPromise as Promise<unknown>,
    ]);

    expect(first.status, 'the first same-tick call resolves').toBe('fulfilled');
    if (first.status === 'fulfilled') {
      const { path } = first.value as { path: unknown };
      expect(typeof path).toBe('string');
      expect((path as string).endsWith('.heapsnapshot')).toBe(true);
      expect(existsSync(path as string)).toBe(true);
    }

    expect(second.status, 'the second same-tick call rejects').toBe('rejected');
    if (second.status === 'rejected') {
      const reason: unknown = second.reason;
      expect(reason).toBeInstanceOf(Error);
      expect((reason as Error).message).toContain('already in progress');
    }
    expect(snapshotFilesIn(dir).length, 'exactly one snapshot written').toBe(1);
  }, 120_000);
});
