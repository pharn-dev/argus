import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const srcDir = join(repoRoot, 'src');
const EXAMPLE_ENTRY = 'examples/worker-pool/index.mjs';

const DIST_FILES = [
  'dist/esm/agent/auto.js',
  'dist/esm/analyzer/index.js',
  'dist/esm/analyzer/workers/heap-snapshot.worker.js',
].map((p) => join(repoRoot, p));

const BUILD_TIMEOUT_MS = 170_000;
const LOCK_WAIT_MS = 170_000;
const LOCK_STALE_MS = 300_000;
const LOCK_POLL_MS = 250;
const RUN_TIMEOUT_MS = 60_000;

const lockDir = join(
  tmpdir(),
  `argus-dist-build-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 16)}.lock`,
);

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

function distIsFresh(): boolean {
  if (!DIST_FILES.every((f) => existsSync(f))) return false;
  const oldestDist = Math.min(...DIST_FILES.map((f) => statSync(f).mtimeMs));
  return newestSourceMtimeMs(srcDir) <= oldestDist;
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

async function ensureFreshDist(): Promise<void> {
  if (distIsFresh()) return;
  await withBuildLock(() => {
    if (!distIsFresh()) buildDist();
  });
}

function exampleEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ARGUS_')) delete env[key];
  }
  return env;
}

type RunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function runExample(): Promise<RunResult> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [EXAMPLE_ENTRY], {
      cwd: repoRoot,
      env: exampleEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, stdout, stderr, timedOut });
    });
  });
}

describe('examples/worker-pool: heap snapshot analysis on the analyzer pool', () => {
  beforeAll(async () => {
    await ensureFreshDist();
  }, 180_000);

  it('AC-2: the example prints a heap-snapshot summary and the main event loop ticked during the analysis', async () => {
    const result = await runExample();
    const diagnostics = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

    expect(result.timedOut, diagnostics).toBe(false);
    expect(result.signal, diagnostics).toBeNull();
    expect(result.code, diagnostics).toBe(0);

    const snapshot =
      /^\[worker-pool\] heap snapshot: nodes=([1-9]\d*) totalSelfSize=([1-9]\d*)$/m.exec(
        result.stdout,
      );
    expect(snapshot, diagnostics).not.toBeNull();
    const nodes = Number(snapshot?.[1]);
    const totalSelfSize = Number(snapshot?.[2]);
    expect(Number.isSafeInteger(nodes)).toBe(true);
    expect(nodes).toBeGreaterThan(0);
    expect(Number.isSafeInteger(totalSelfSize)).toBe(true);
    expect(totalSelfSize).toBeGreaterThan(0);

    const topNames = [
      ...result.stdout.matchAll(/^\[worker-pool\] heap top: (\S.*?) count=\d+ selfSize=\d+$/gm),
    ].map((m) => m[1] ?? '');
    expect(topNames.length, diagnostics).toBeGreaterThanOrEqual(1);
    for (const name of topNames) {
      expect(name.trim().length).toBeGreaterThan(0);
    }

    const ticks = /^\[worker-pool\] event loop ticks during analysis: (\d+)$/m.exec(result.stdout);
    expect(ticks, diagnostics).not.toBeNull();
    const tickCount = Number(ticks?.[1]);
    expect(Number.isSafeInteger(tickCount)).toBe(true);
    expect(tickCount).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
