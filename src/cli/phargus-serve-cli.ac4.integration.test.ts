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
const STARTUP_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 15_000;
const EVENT_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 300_000;

/** The dashboard URL line the CLI prints on stderr. */
const URL_LINE = /http:\/\/127\.0\.0\.1:(\d+)/;
const INPUT_ENDED_LINE = /input ended/i;
const COUNTS_LINE =
  /decoder\.invalid=(\d+)[^\n]*decoder\.oversized=(\d+)[^\n]*collector\.ignored=(\d+)/;

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
const connections: SseConnection[] = [];

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

/** Writes a chunk to the CLI's stdin and resolves once it has been handed to the pipe. */
function writeStdin(run: CliRun, text: string): Promise<void> {
  return new Promise((done, fail) => {
    run.child.stdin.write(text, (err) => {
      if (err) fail(err);
      else done();
    });
  });
}

type SseConnection = {
  request: ClientRequest;
  statusCode: number;
  body: () => string;
  errors: string[];
};

/** Opens GET /events and resolves on the response headers; the body is collected as it arrives. */
function openEvents(port: number): Promise<SseConnection> {
  return new Promise((done, fail) => {
    let body = '';
    const errors: string[] = [];
    const request = httpRequest(
      { host: '127.0.0.1', port, path: '/events', method: 'GET', agent: false },
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

type SseEvent = { event: string; data: string[] };

/** Parses every complete SSE block of the text into events (comment lines are skipped). */
function parseSse(raw: string): SseEvent[] {
  const blocks = raw.split('\r\n').join('\n').split('\n\n');
  blocks.pop();
  const events: SseEvent[] = [];
  for (const block of blocks) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        const value = line.slice('data:'.length);
        data.push(value.startsWith(' ') ? value.slice(1) : value);
      }
    }
    if (event !== undefined) {
      events.push({ event, data });
    }
  }
  return events;
}

function windowsOf(connection: SseConnection): unknown[] {
  return parseSse(connection.body())
    .filter((event) => event.event === 'window')
    .map((event) => JSON.parse(event.data.join('\n')) as unknown);
}

/** Waits until the connection has received at least one `window` event. */
async function waitForWindow(connection: SseConnection, run: CliRun): Promise<unknown[]> {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  for (;;) {
    const windows = windowsOf(connection);
    if (windows.length > 0) return windows;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for a window event\nSSE body:\n${connection.body()}\n${diagnostics(run)}`,
      );
    }
    await sleep(50);
  }
}

afterAll(async () => {
  for (const connection of connections) {
    connection.request.destroy();
  }
  for (const run of runs) {
    await stopCli(run);
  }
}, 60_000);

/** A full agent sample object, the shape the auto-started agent writes. */
function makeSample(timestamp: number, eventLoopMax: number): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1, max: eventLoopMax, mean: 10, p50: 9, p99: 18 },
    memory: {
      heapUsed: 1000 + eventLoopMax,
      heapTotal: 4000,
      rss: 9000,
      external: 0,
      arrayBuffers: 0,
    },
    gc: {
      count: 1,
      totalPause: 3,
      maxPause: 3,
      kinds: { minor: 1, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
    dropped: { samples: 0, spans: 0 },
  };
}

const BASE_MS = 1_700_000_000_000;

describe('phargus serve: stdin with mixed agent and log lines', () => {
  it(
    'AC-4: prints the dashboard URL, streams windows over SSE, reports the input end with the skip and ignored counts, and keeps serving after stdin ends',
    async () => {
      await ensureFreshDist();
      const { encodeNdjsonLine } = await import('../agent/index.js');

      const samples = [
        makeSample(BASE_MS + 100, 40),
        makeSample(BASE_MS + 600, 60),
        makeSample(BASE_MS + 1_200, 80),
        makeSample(BASE_MS + 1_700, 30),
        makeSample(BASE_MS + 2_300, 50),
        makeSample(BASE_MS + 3_400, 20),
      ];
      const plainLines = [
        'Server listening on http://127.0.0.1:3000',
        'GET /users 200 12ms',
        'warning: cache miss for key "users"',
      ];
      const pinoLines = [
        JSON.stringify({ level: 30, time: BASE_MS, pid: 42, msg: 'request completed' }),
        JSON.stringify({ level: 40, time: BASE_MS + 100, pid: 42, msg: 'slow query' }),
      ];
      const N = plainLines.length;
      const M = pinoLines.length;

      const [s0, s1, s2, s3, s4, s5] = samples;
      const [t0, t1, t2] = plainLines;
      const [j0, j1] = pinoLines;
      const input =
        `${t0}\n` +
        encodeNdjsonLine(s0) +
        `${j0}\n` +
        encodeNdjsonLine(s1) +
        `${t1}\n` +
        encodeNdjsonLine(s2) +
        encodeNdjsonLine(s3) +
        `${j1}\n` +
        encodeNdjsonLine(s4) +
        `${t2}\n` +
        encodeNdjsonLine(s5);

      const run = startCli(['serve', '--port', '0', '--window-ms', '1000']);
      const port = await waitForPort(run);
      expect(port, diagnostics(run)).toBeGreaterThan(0);

      const live = await openEvents(port);
      expect(live.statusCode, diagnostics(run)).toBe(200);

      await writeStdin(run, input);
      const liveWindows = await waitForWindow(live, run);
      expect(liveWindows.length).toBeGreaterThanOrEqual(1);

      run.child.stdin.end();
      await waitForStderr(run, INPUT_ENDED_LINE, EVENT_TIMEOUT_MS);
      const counts = await waitForStderr(run, COUNTS_LINE, EVENT_TIMEOUT_MS);
      const invalid = Number(counts[1]);
      const oversized = Number(counts[2]);
      const ignored = Number(counts[3]);
      expect(invalid + oversized, `decoder skip count\n${diagnostics(run)}`).toBe(N);
      expect(ignored, `collector ignored count\n${diagnostics(run)}`).toBe(M);

      expect(
        run.exitInfo(),
        `the CLI must keep running after its input ended\n${diagnostics(run)}`,
      ).toBeUndefined();
      const late = await openEvents(port);
      expect(late.statusCode, diagnostics(run)).toBe(200);
      const lateWindows = await waitForWindow(late, run);
      expect(lateWindows.length).toBeGreaterThanOrEqual(1);
      expect(run.exitInfo(), diagnostics(run)).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});
