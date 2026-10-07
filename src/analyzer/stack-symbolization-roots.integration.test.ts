// F-15: the symbolizer confines reads to `roots`, caps file size and never leaks file content.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSymbolizationPool,
  MalformedSourceMapError,
  symbolizeStackFrames,
  type WorkerPool,
} from './index.js';

const SECRET = 'TOP-SECRET-0123456789';

// One segment "AAAA": generated column 0 -> sources[0] line 0 column 0.
function sourceMap(): string {
  return JSON.stringify({ version: 3, sources: ['src/app.ts'], names: [], mappings: 'AAAA' });
}

function builtFile(mapUrl: string): string {
  return `console.log(1);\n//# sourceMappingURL=${mapUrl}\n`;
}

let base: string;
let root: string;
let outside: string;
let pool: WorkerPool;

beforeAll(async () => {
  // tmpdir() is itself behind a symlink on macOS (/var -> /private/var): roots must still match.
  base = await mkdtemp(join(tmpdir(), 'argus-roots-'));
  root = join(base, 'app');
  outside = join(base, 'outside');
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), `${SECRET}\n`);
  await writeFile(join(outside, 'outside.js.map'), sourceMap());
  await writeFile(join(outside, 'outside.js'), builtFile('outside.js.map'));
  await writeFile(join(root, 'dist', 'app.js.map'), sourceMap());
  await writeFile(join(root, 'dist', 'app.js'), builtFile('app.js.map'));
  // The built file is inside the root, its map escapes through `..`.
  await writeFile(join(root, 'dist', 'dotdot.js'), builtFile('../../outside/outside.js.map'));
  // A symlink inside the root pointing at a built file outside it.
  await symlink(join(outside, 'outside.js'), join(root, 'dist', 'linked.js'));
  // A symlinked map inside the root pointing outside.
  await symlink(join(outside, 'outside.js.map'), join(root, 'dist', 'linked.js.map'));
  await writeFile(join(root, 'dist', 'linkedmap.js'), builtFile('linked.js.map'));
  // A "source map" that is really a secret text file.
  await writeFile(join(root, 'dist', 'leak.js'), builtFile('../../outside/secret.txt'));
  pool = createSymbolizationPool();
});

afterAll(async () => {
  await pool.close();
  await rm(base, { recursive: true, force: true });
});

function frame(path: string): { url: string; line: number; column: number } {
  return { url: pathToFileURL(path).href, line: 1, column: 1 };
}

describe('symbolizer roots and caps (F-15)', () => {
  it('maps files inside the roots and leaves files reached outside them unchanged', async () => {
    const frames = [
      frame(join(root, 'dist', 'app.js')),
      frame(join(outside, 'outside.js')),
      frame(join(root, 'dist', 'dotdot.js')),
      frame(join(root, 'dist', 'linked.js')),
      frame(join(root, 'dist', 'linkedmap.js')),
      frame(join(root, 'dist', 'leak.js')),
      { url: join(root, 'dist', '..', '..', 'outside', 'outside.js'), line: 1, column: 1 },
    ];
    const result = await symbolizeStackFrames(frames, { pool, roots: [root] });
    expect(result[0]?.original?.url).toMatch(/\/app\/dist\/src\/app\.ts$/);
    for (const [index, symbolized] of result.slice(1).entries()) {
      expect(symbolized, `frame ${String(index + 1)}`).toEqual(frames[index + 1]);
    }
  });

  it('still reads any local file without roots, but never puts file bytes in the error', async () => {
    const [mapped, leaked] = await symbolizeStackFrames(
      [frame(join(outside, 'outside.js')), frame(join(root, 'dist', 'leak.js'))],
      { pool },
    );
    expect(mapped?.original).toBeDefined();
    expect(leaked?.error).toBeInstanceOf(MalformedSourceMapError);
    expect(leaked?.error?.message).toContain('not valid JSON');
    expect(leaked?.error?.message).not.toMatch(/TOP|SECRET|0123/);
  });

  it('caps the size of files read', async () => {
    const [built, map] = await symbolizeStackFrames(
      [frame(join(root, 'dist', 'app.js')), frame(join(outside, 'outside.js'))],
      { pool, maxFileBytes: 32 },
    );
    // The built file (> 32 bytes) is not read at all.
    expect(built).toEqual(frame(join(root, 'dist', 'app.js')));
    expect(map?.original).toBeUndefined();

    const mapCapped = join(base, 'cap');
    await mkdir(mapCapped, { recursive: true });
    await writeFile(join(mapCapped, 'a.js'), 'x\n//# sourceMappingURL=a.js.map\n');
    await writeFile(join(mapCapped, 'a.js.map'), sourceMap().padEnd(200, ' '));
    const [capped] = await symbolizeStackFrames([frame(join(mapCapped, 'a.js'))], {
      pool,
      maxFileBytes: 100,
    });
    expect(capped?.error).toBeInstanceOf(MalformedSourceMapError);
    expect(capped?.error?.message).toContain('100-byte maxFileBytes limit');
  });

  it('refuses a file cap the worker heap cannot parse, and validates roots', async () => {
    const small = createSymbolizationPool({ resourceLimits: { maxOldGenerationSizeMb: 64 } });
    try {
      // The default cap shrinks to fit a small heap; an explicit cap that does not fit is refused.
      await expect(
        symbolizeStackFrames([frame(join(root, 'dist', 'app.js'))], { pool: small }),
      ).resolves.toHaveLength(1);
      await expect(
        symbolizeStackFrames([], { pool: small, maxFileBytes: 64 * 1024 * 1024 }),
      ).rejects.toThrow(/heap of at least 512 MiB/);
      await expect(
        symbolizeStackFrames([], { pool: small, maxFileBytes: 8 * 1024 * 1024 }),
      ).resolves.toEqual([]);
    } finally {
      await small.close();
    }
    await expect(symbolizeStackFrames([], { pool, roots: [''] })).rejects.toThrow(TypeError);
  });
});
