import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const srcDir = join(repoRoot, 'src');
const EXAMPLE_ENTRY = 'examples/express-app/index.mjs';

const DIST_FILES = [
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
const WINDOW_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 15_000;
const LAG_THRESHOLD_NS = 50_000_000;

const APP_LINE = /^\[express-app\] app listening on http:\/\/127\.0\.0\.1:(\d+)$/m;
const DASHBOARD_LINE = /^\[express-app\] dashboard listening on http:\/\/127\.0\.0\.1:(\d+)$/m;

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

/** The oldest mtime of the dist files, or undefined when any of them is missing. */
function oldestDistMtimeMs(): number | undefined {
  let oldest = Number.POSITIVE_INFINITY;
  for (const file of DIST_FILES) {
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

function exampleEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ARGUS_')) delete env[key];
  }
  env['APP_PORT'] = '0';
  env['DASHBOARD_PORT'] = '0';
  return env;
}

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

type ExampleRun = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stdout: () => string;
  stderr: () => string;
  exitInfo: () => ExitInfo | undefined;
  exited: Promise<ExitInfo>;
};

/** Spawns the example entry; output is collected as it arrives and every stream error is recorded. */
function startExample(): ExampleRun {
  const child = spawn(process.execPath, [EXAMPLE_ENTRY], {
    cwd: repoRoot,
    env: exampleEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exitInfo: ExitInfo | undefined;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on('error', (err) => {
    stderr += `\n[test] child stdout error: ${err.message}\n`;
  });
  child.stderr.on('error', (err) => {
    stderr += `\n[test] child stderr error: ${err.message}\n`;
  });
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
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exitInfo: () => exitInfo,
    exited,
  };
}

function diagnostics(run: ExampleRun): string {
  return `stdout:\n${run.stdout()}\nstderr:\n${run.stderr()}\nexit: ${JSON.stringify(run.exitInfo() ?? null)}`;
}

/** Waits for both address lines; fails if the example exits first or the timeout passes. */
async function waitForPorts(
  run: ExampleRun,
  timeoutMs: number,
): Promise<{ appPort: number; dashboardPort: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const app = APP_LINE.exec(run.stdout());
    const dashboard = DASHBOARD_LINE.exec(run.stdout());
    if (app && dashboard) {
      return { appPort: Number(app[1]), dashboardPort: Number(dashboard[1]) };
    }
    if (run.exitInfo() !== undefined) {
      throw new Error(`the example exited before reporting its addresses\n${diagnostics(run)}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the example's addresses\n${diagnostics(run)}`);
    }
    await sleep(25);
  }
}

/** Sends SIGTERM (then SIGKILL after a bound) to a still-running example and waits for it to exit. */
async function stopExample(run: ExampleRun): Promise<void> {
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

/** GETs a path on 127.0.0.1 and resolves with the status code once the body has been read. */
function httpGet(port: number, path: string): Promise<number> {
  return new Promise((done, fail) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false },
      (response) => {
        response.on('error', fail);
        response.on('end', () => {
          done(response.statusCode ?? 0);
        });
        response.resume();
      },
    );
    request.on('error', fail);
    request.setTimeout(HTTP_TIMEOUT_MS, () => {
      request.destroy(new Error(`GET ${path} timed out`));
    });
    request.end();
  });
}

type SseConnection = {
  request: ClientRequest;
  statusCode: number;
  contentType: string;
  body: () => string;
  errors: () => string[];
};

/** Opens GET /events and resolves on the response headers; the body is collected as it arrives. */
function openSse(port: number): Promise<SseConnection> {
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
        done({
          request,
          statusCode: response.statusCode ?? 0,
          contentType: String(response.headers['content-type'] ?? ''),
          body: () => body,
          errors: () => errors,
        });
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

type WindowView = { end: unknown; eventLoopMax: unknown };

function windowsOf(connection: SseConnection): WindowView[] {
  return parseSse(connection.body())
    .filter((event) => event.event === 'window')
    .map((event) => {
      const parsed = JSON.parse(event.data.join('\n')) as unknown;
      const record =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const eventLoop = record['eventLoop'];
      const eventLoopMax =
        typeof eventLoop === 'object' && eventLoop !== null
          ? (eventLoop as Record<string, unknown>)['max']
          : undefined;
      return { end: record['end'], eventLoopMax };
    });
}

/** Polls the predicate until it holds, or fails after the timeout with the given diagnostics. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what()}`);
    }
    await sleep(50);
  }
}

let current: ExampleRun | undefined;
const connections: SseConnection[] = [];

afterAll(async () => {
  for (const connection of connections) {
    connection.request.destroy();
  }
  if (current !== undefined) {
    await stopExample(current);
  }
}, 40_000);

describe('examples/express-app: the slow route shows up as event-loop lag in a window event', () => {
  beforeAll(async () => {
    await ensureFreshDist();
  }, 180_000);

  it('AC-2: after a request to the slow route the SSE stream delivers a window event with eventLoop.max of at least 50 ms', async () => {
    const run = startExample();
    current = run;
    const { appPort, dashboardPort } = await waitForPorts(run, STARTUP_TIMEOUT_MS);

    const sse = await openSse(dashboardPort);
    connections.push(sse);
    expect(sse.statusCode, diagnostics(run)).toBe(200);
    expect(sse.contentType).toMatch(/^text\/event-stream/);

    const sentAt = Date.now();
    expect(await httpGet(appPort, '/slow'), diagnostics(run)).toBe(200);

    const laggedAfterRequest = (): boolean =>
      windowsOf(sse).some(
        (window) =>
          typeof window.end === 'number' &&
          window.end >= sentAt &&
          typeof window.eventLoopMax === 'number' &&
          window.eventLoopMax >= LAG_THRESHOLD_NS,
      );
    await waitFor(
      laggedAfterRequest,
      WINDOW_TIMEOUT_MS,
      () =>
        `a window event ending at or after ${String(sentAt)} with eventLoop.max >= ${String(LAG_THRESHOLD_NS)}\nSSE body:\n${sse.body()}\n${diagnostics(run)}`,
    );
    expect(laggedAfterRequest()).toBe(true);
    expect(sse.errors()).toEqual([]);
  }, 90_000);
});
