import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const LOCK_WAIT_MS = 170_000;
const LOCK_STALE_MS = 300_000;
const LOCK_POLL_MS = 250;
const RUN_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 240_000;

const lockDir = join(
  tmpdir(),
  `phargus-dist-build-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 16)}.lock`,
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

async function ensureFreshDist(): Promise<void> {
  if (distIsFresh()) return;
  await withBuildLock(() => {
    if (!distIsFresh()) buildDist();
  });
}

/** The test's environment without any PHARGUS_* variable. */
function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PHARGUS_')) delete env[key];
  }
  return env;
}

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

type CliRun = {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  notes: string[];
  exitInfo: () => ExitInfo | undefined;
  exited: Promise<ExitInfo>;
};

const runs: CliRun[] = [];

/** Spawns `node dist/esm/cli/bin.js <args>`; output is collected as it arrives. */
function startCli(args: readonly string[]): CliRun {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: repoRoot,
    env: cliEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exitInfo: ExitInfo | undefined;
  const notes: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on('error', (err) => notes.push(`child stdout error: ${err.message}`));
  child.stderr.on('error', (err) => notes.push(`child stderr error: ${err.message}`));
  child.stdin.on('error', (err) => notes.push(`child stdin error: ${err.message}`));
  const exited = new Promise<ExitInfo>((done) => {
    child.once('error', (error) => {
      exitInfo ??= { code: null, signal: null, error };
      done(exitInfo);
    });
    child.once('close', (code, signal) => {
      exitInfo ??= { code, signal };
      done(exitInfo);
    });
  });
  const run: CliRun = {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    notes,
    exitInfo: () => exitInfo,
    exited,
  };
  runs.push(run);
  return run;
}

function diagnostics(run: CliRun): string {
  return `stdout:\n${run.stdout()}\nstderr:\n${run.stderr()}\nnotes: ${run.notes.join('; ')}\nexit: ${JSON.stringify(run.exitInfo() ?? null)}`;
}

/** Waits for the run to exit; a run still alive after the timeout is killed and the wait fails. */
async function waitForExit(run: CliRun, timeoutMs: number): Promise<ExitInfo> {
  const timedOut = await Promise.race([
    run.exited.then(() => false),
    sleep(timeoutMs).then(() => true),
  ]);
  if (timedOut) {
    run.child.kill('SIGKILL');
    await run.exited;
    throw new Error(`the CLI did not exit within ${timeoutMs} ms\n${diagnostics(run)}`);
  }
  return run.exited;
}

/** Runs the CLI with an empty stdin to completion. */
async function runCli(args: readonly string[]): Promise<{ run: CliRun; exit: ExitInfo }> {
  const run = startCli(args);
  run.child.stdin.end();
  const exit = await waitForExit(run, RUN_TIMEOUT_MS);
  return { run, exit };
}

async function stopCli(run: CliRun): Promise<void> {
  if (run.exitInfo() !== undefined) return;
  run.child.kill('SIGTERM');
  const timedOut = await Promise.race([
    run.exited.then(() => false),
    sleep(STOP_TIMEOUT_MS).then(() => true),
  ]);
  if (timedOut) {
    run.child.kill('SIGKILL');
    await run.exited;
  }
}

afterAll(async () => {
  for (const run of runs) {
    await stopCli(run);
  }
}, 60_000);

describe('phargus CLI: --help and --version', () => {
  it(
    'AC-1: --help exits 0 and prints to stdout a usage text naming serve and --port, --host, --token, --window-ms and --max-line-bytes',
    async () => {
      await ensureFreshDist();
      const { run, exit } = await runCli(['--help']);

      expect(exit.code, diagnostics(run)).toBe(0);
      for (const word of [
        'serve',
        '--port',
        '--host',
        '--token',
        '--window-ms',
        '--max-line-bytes',
      ]) {
        expect(run.stdout(), `usage text names ${word}\n${diagnostics(run)}`).toContain(word);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "AC-1: --version exits 0 and prints to stdout the package.json's version",
    async () => {
      await ensureFreshDist();
      const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      expect(typeof manifest.version).toBe('string');
      const version = String(manifest.version);

      const { run, exit } = await runCli(['--version']);

      expect(exit.code, diagnostics(run)).toBe(0);
      expect(run.stdout(), diagnostics(run)).toContain(version);
    },
    TEST_TIMEOUT_MS,
  );
});
