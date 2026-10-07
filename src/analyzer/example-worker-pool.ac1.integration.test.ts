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

describe('examples/worker-pool: CPU tasks on Worker Threads', () => {
  beforeAll(async () => {
    await ensureFreshDist();
  }, 180_000);

  it('AC-1: the example exits 0 with the agent enabled and reports the completed CPU worker tasks', async () => {
    const result = await runExample();
    const diagnostics = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

    expect(result.timedOut, diagnostics).toBe(false);
    expect(result.signal, diagnostics).toBeNull();
    expect(result.code, diagnostics).toBe(0);
    expect(result.stderr).not.toContain('[argus] agent disabled');

    const match = /^\[worker-pool\] cpu tasks completed: ([1-9]\d*)$/m.exec(result.stdout);
    expect(match, diagnostics).not.toBeNull();
    const tasks = Number(match?.[1]);
    expect(Number.isSafeInteger(tasks)).toBe(true);
    expect(tasks).toBeGreaterThan(0);
  }, 90_000);
});
