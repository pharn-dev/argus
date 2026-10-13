import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const srcDir = join(repoRoot, 'src');
const BIN = join(repoRoot, 'dist', 'esm', 'cli', 'bin.js');
const CLI_SOURCE = join(srcDir, 'cli', 'bin.ts');
const CORE_DIST = [
  'dist/esm/agent/auto.js',
  'dist/esm/collector/index.js',
  'dist/esm/dashboard/index.js',
].map((p) => join(repoRoot, p));

const BUILD_TIMEOUT_MS = 170_000;
const PACK_TIMEOUT_MS = 120_000;
const LOCK_WAIT_MS = 170_000;
const LOCK_STALE_MS = 300_000;
const LOCK_POLL_MS = 250;
const TEST_TIMEOUT_MS = 360_000;

const lockDir = join(
  tmpdir(),
  `phargus-dist-build-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 16)}.lock`,
);

const tempDirs: string[] = [];

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function newestSourceMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtimeMs(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

/** The dist files the CLI runs from; the bin is expected only once its source exists. */
function requiredDistFiles(): string[] {
  return existsSync(CLI_SOURCE) ? [...CORE_DIST, BIN] : CORE_DIST;
}

/** The oldest mtime of the required dist files, or undefined when any of them is missing. */
function oldestDistMtimeMs(): number | undefined {
  let oldest = Number.POSITIVE_INFINITY;
  for (const file of requiredDistFiles()) {
    try {
      oldest = Math.min(oldest, statSync(file).mtimeMs);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return undefined;
      throw err;
    }
  }
  return oldest;
}

function distIsFresh(): boolean {
  const oldestDist = oldestDistMtimeMs();
  return oldestDist !== undefined && newestSourceMtimeMs(srcDir) <= oldestDist;
}

function lockIsStale(): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

async function withBuildLock(fn: () => void): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err;
      if (lockIsStale()) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the dist build lock at ${lockDir}`, {
          cause: err,
        });
      }
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function buildDist(): void {
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `node scripts/build.mjs failed (status ${String(result.status)}, signal ${String(result.signal)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

/**
 * Packs the package into `destination` with `npm pack --ignore-scripts` and returns the tarball's
 * path. `prepack` would rebuild (and first delete) dist/, so the pack runs under the shared build
 * lock after a fresh build, never racing another test's build.
 */
async function packFreshTarball(destination: string): Promise<string> {
  await withBuildLock(() => {
    if (!distIsFresh()) buildDist();
    const result = spawnSync(
      'npm',
      ['pack', '--ignore-scripts', '--pack-destination', destination],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: PACK_TIMEOUT_MS,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `npm pack failed (status ${String(result.status)}, signal ${String(result.signal)}):\n${result.stdout}\n${result.stderr}`,
      );
    }
  });
  const tarballs = readdirSync(destination).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(
      `expected exactly one tarball in ${destination}, found ${JSON.stringify(tarballs)}`,
    );
  }
  return join(destination, String(tarballs[0]));
}

type TarEntry = { mode: number; data: Buffer };

function cString(bytes: Buffer): string {
  const nul = bytes.indexOf(0);
  return (nul === -1 ? bytes : bytes.subarray(0, nul)).toString('utf8');
}

function octal(bytes: Buffer): number {
  const text = cString(bytes).trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/** The `path` record of a pax extended header, if it has one. */
function paxPath(data: Buffer): string | undefined {
  let offset = 0;
  const text = data.toString('utf8');
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    const eq = record.indexOf('=');
    if (eq !== -1 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
    offset += length;
  }
  return undefined;
}

/** Reads the regular-file entries of a gzipped ustar/pax tarball: path -> mode and contents. */
function readTarball(file: string): Map<string, TarEntry> {
  const tar = gunzipSync(readFileSync(file));
  const entries = new Map<string, TarEntry>();
  let offset = 0;
  let nextPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = cString(header.subarray(0, 100));
    const mode = octal(header.subarray(100, 108));
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = cString(header.subarray(345, 500));
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      nextPath = paxPath(data);
      continue;
    }
    if (type === 'L') {
      nextPath = cString(data);
      continue;
    }
    if (type === 'g') continue;
    const path = nextPath ?? (prefix === '' ? name : `${prefix}/${name}`);
    nextPath = undefined;
    if (type === '0' || type === '\0') {
      entries.set(path, { mode, data: Buffer.from(data) });
    }
  }
  return entries;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('phargus CLI: the packed tarball ships the bin', () => {
  it(
    "AC-9: npm pack's manifest maps bin phargus to a file in the tarball whose first line is #!/usr/bin/env node and whose mode is executable",
    async () => {
      const destination = mkdtempSync(join(tmpdir(), 'phargus-ac9-pack-'));
      tempDirs.push(destination);
      const tarball = await packFreshTarball(destination);
      const entries = readTarball(tarball);

      const manifestEntry = entries.get('package/package.json');
      expect(
        manifestEntry,
        `package/package.json in ${[...entries.keys()].join(', ')}`,
      ).toBeDefined();
      const manifest = JSON.parse(manifestEntry?.data.toString('utf8') ?? '{}') as {
        name?: unknown;
        bin?: unknown;
      };

      const bin = manifest.bin;
      let target: unknown;
      if (typeof bin === 'string') {
        target = bin;
      } else if (typeof bin === 'object' && bin !== null) {
        target = (bin as Record<string, unknown>)['phargus'];
      }
      expect(typeof target, `manifest bin: ${JSON.stringify(bin)}`).toBe('string');

      const entryPath = `package/${posix.normalize(String(target)).replace(/^\.\//, '')}`;
      const binEntry = entries.get(entryPath);
      expect(binEntry, `${entryPath} in ${[...entries.keys()].join(', ')}`).toBeDefined();

      const firstLine = (binEntry?.data.toString('utf8') ?? '').split('\n')[0];
      expect(firstLine).toBe('#!/usr/bin/env node');
      expect((binEntry?.mode ?? 0) & 0o111, `mode ${(binEntry?.mode ?? 0).toString(8)}`).not.toBe(
        0,
      );
    },
    TEST_TIMEOUT_MS,
  );
});
