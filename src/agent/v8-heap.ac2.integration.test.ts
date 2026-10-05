import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function expectSnapshotFile(result: unknown, dir: string): string {
  expect(typeof result, 'resolves with an object').toBe('object');
  expect(result, 'resolves with a non-null object').not.toBeNull();
  const { path, bytes } = result as { path: unknown; bytes: unknown };

  expect(typeof path, 'path is a string').toBe('string');
  const filePath = path as string;
  expect(resolve(dirname(filePath)), 'path is inside the directory').toBe(resolve(dir));
  expect(filePath.endsWith('.heapsnapshot'), `${filePath} ends in .heapsnapshot`).toBe(true);

  expect(typeof bytes, 'bytes is a number').toBe('number');
  expect(Number.isInteger(bytes), 'bytes is an integer').toBe(true);
  expect(bytes as number, 'bytes > 0').toBeGreaterThan(0);

  // Read once (throws if the file is missing) so existence, size and content are checked on
  // the same bytes — no check-then-use race on the path.
  const content = readFileSync(filePath);
  expect(content.length, 'file size equals bytes').toBe(bytes);

  const parsed = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
  expect(parsed, 'top-level snapshot key').toHaveProperty('snapshot');
  const snapshot = parsed['snapshot'] as Record<string, unknown>;
  expect(typeof snapshot['meta'], 'snapshot.meta is an object').toBe('object');
  expect(snapshot['meta'], 'snapshot.meta is not null').not.toBeNull();
  return filePath;
}

describe('agent on-demand heap snapshot — AC-2', () => {
  it('AC-2: two sequential takeHeapSnapshot({ dir }) calls write distinct parseable .heapsnapshot files whose size equals bytes', async () => {
    const { takeHeapSnapshot } = await import('./index.js');
    const dir = mkdtempSync(join(tmpdir(), 'argus-v8-heap-ac2-'));
    tempDirs.push(dir);

    const first: unknown = await takeHeapSnapshot({ dir });
    const firstPath = expectSnapshotFile(first, dir);

    const second: unknown = await takeHeapSnapshot({ dir });
    const secondPath = expectSnapshotFile(second, dir);

    expect(secondPath, 'the two snapshot paths differ').not.toBe(firstPath);
  }, 120_000);
});
