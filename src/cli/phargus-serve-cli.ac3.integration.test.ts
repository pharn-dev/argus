import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
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
const STARTUP_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 240_000;

/** The dashboard URL line the CLI prints on stderr. */
const URL_LINE = /http:\/\/127\.0\.0\.1:(\d+)/;

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

/** The test's environment without any PHARGUS_* variable, plus the given extra variables. */
function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PHARGUS_')) delete env[key];
  }
  return { ...env, ...extra };
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
const connections: SseConnection[] = [];

/** Spawns `node dist/esm/cli/bin.js <args>`; output is collected as it arrives. */
function startCli(args: readonly string[], env: NodeJS.ProcessEnv = cliEnv()): CliRun {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: repoRoot,
    env,
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

/** Waits until stderr matches the pattern; fails if the CLI exits first or the timeout passes. */
async function waitForStderr(
  run: CliRun,
  pattern: RegExp,
  timeoutMs: number,
): Promise<RegExpExecArray> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = pattern.exec(run.stderr());
    if (match) return match;
    if (run.exitInfo() !== undefined) {
      throw new Error(
        `the CLI exited before its stderr matched ${String(pattern)}\n${diagnostics(run)}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for stderr to match ${String(pattern)}\n${diagnostics(run)}`,
      );
    }
    await sleep(25);
  }
}

/** Waits for the dashboard URL line and returns the port it names. */
async function waitForPort(run: CliRun): Promise<number> {
  const match = await waitForStderr(run, URL_LINE, STARTUP_TIMEOUT_MS);
  return Number(match[1]);
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

type SseConnection = {
  request: ClientRequest;
  statusCode: number;
  body: () => string;
  errors: string[];
};

/** Opens GET /events and resolves on the response headers; the body is collected as it arrives. */
function openEvents(port: number, headers: Record<string, string> = {}): Promise<SseConnection> {
  return new Promise((done, fail) => {
    let body = '';
    const errors: string[] = [];
    const request = httpRequest(
      { host: '127.0.0.1', port, path: '/events', method: 'GET', agent: false, headers },
      (response) => {
        clearTimeout(timer);
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('error', (err) => {
          errors.push(err.message);
        });
        const connection: SseConnection = {
          request,
          statusCode: response.statusCode ?? 0,
          body: () => body,
          errors,
        };
        connections.push(connection);
        done(connection);
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new Error('GET /events got no response headers in time'));
    }, HTTP_TIMEOUT_MS);
    request.on('error', (err) => {
      clearTimeout(timer);
      errors.push(err.message);
      fail(err);
    });
    request.end();
  });
}

afterAll(async () => {
  for (const connection of connections) {
    connection.request.destroy();
  }
  for (const run of runs) {
    await stopCli(run);
  }
}, 60_000);

describe('phargus serve: the token gate', () => {
  it(
    'AC-3: serve --host 0.0.0.0 --port 0 with no --token and no PHARGUS_TOKEN exits 2 saying a token is required for a non-loopback host',
    async () => {
      await ensureFreshDist();
      const run = startCli(['serve', '--host', '0.0.0.0', '--port', '0']);
      const exit = await waitForExit(run, RUN_TIMEOUT_MS);

      expect(exit.code, diagnostics(run)).toBe(2);
      expect(run.stderr(), diagnostics(run)).toMatch(/token/i);
      expect(run.stderr(), diagnostics(run)).toMatch(/required/i);
      expect(run.stderr(), diagnostics(run)).toMatch(/loopback/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'AC-3: with PHARGUS_TOKEN set, serve --port 0 on loopback answers GET /events with 401 without credentials and 200 with Authorization: Bearer <token>',
    async () => {
      await ensureFreshDist();
      const token = `ac3-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 24)}`;
      const run = startCli(['serve', '--port', '0'], cliEnv({ PHARGUS_TOKEN: token }));
      const port = await waitForPort(run);
      expect(port, diagnostics(run)).toBeGreaterThan(0);

      const anonymous = await openEvents(port);
      expect(anonymous.statusCode, diagnostics(run)).toBe(401);
      anonymous.request.destroy();

      const authorized = await openEvents(port, { authorization: `Bearer ${token}` });
      expect(authorized.statusCode, diagnostics(run)).toBe(200);
      authorized.request.destroy();
    },
    TEST_TIMEOUT_MS,
  );
});
