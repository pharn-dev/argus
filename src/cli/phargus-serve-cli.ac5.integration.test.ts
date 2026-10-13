import {
  spawn,
  spawnSync,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const srcDir = join(repoRoot, 'src');
const BIN = join(repoRoot, 'dist', 'esm', 'cli', 'bin.js');
const AGENT_ENTRY = join(repoRoot, 'dist', 'esm', 'agent', 'auto.js');
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
const EVENT_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 300_000;

/** The dashboard URL line the CLI prints on stderr. */
const URL_LINE = /http:\/\/127\.0\.0\.1:(\d+)/;

/** The monitored app: it writes its own plain-text log lines to stdout and runs until killed. */
const APP_SOURCE = [
  'let n = 0;',
  "setInterval(() => { console.log('plain app log line ' + String(n++)); }, 200);",
].join('\n');

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
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PHARGUS_')) delete env[key];
  }
  return env;
}

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

type Proc = {
  child: ChildProcessWithoutNullStreams | ChildProcessByStdio<null, Readable, Readable>;
  stderr: () => string;
  notes: string[];
  exitInfo: () => ExitInfo | undefined;
  exited: Promise<ExitInfo>;
};

const procs: Proc[] = [];
const connections: SseConnection[] = [];
const tempDirs: string[] = [];

function track(
  child: ChildProcessWithoutNullStreams | ChildProcessByStdio<null, Readable, Readable>,
): Proc {
  let stderr = '';
  let exitInfo: ExitInfo | undefined;
  const notes: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stderr.on('error', (err) => notes.push(`child stderr error: ${err.message}`));
  child.stdout.on('error', (err) => notes.push(`child stdout error: ${err.message}`));
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
  const proc: Proc = { child, stderr: () => stderr, notes, exitInfo: () => exitInfo, exited };
  procs.push(proc);
  return proc;
}

function describeProc(name: string, proc: Proc): string {
  return `${name} stderr:\n${proc.stderr()}\n${name} notes: ${proc.notes.join('; ')}\n${name} exit: ${JSON.stringify(proc.exitInfo() ?? null)}`;
}

/** Waits until stderr matches the pattern; fails if the process exits first or the timeout passes. */
async function waitForStderr(
  proc: Proc,
  pattern: RegExp,
  timeoutMs: number,
  what: () => string,
): Promise<RegExpExecArray> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = pattern.exec(proc.stderr());
    if (match) return match;
    if (proc.exitInfo() !== undefined) {
      throw new Error(`the process exited before its stderr matched ${String(pattern)}\n${what()}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for stderr to match ${String(pattern)}\n${what()}`);
    }
    await sleep(25);
  }
}

async function stopProc(proc: Proc): Promise<void> {
  if (proc.exitInfo() !== undefined) return;
  proc.child.kill('SIGTERM');
  const timedOut = await Promise.race([
    proc.exited.then(() => false),
    sleep(STOP_TIMEOUT_MS).then(() => true),
  ]);
  if (timedOut) {
    proc.child.kill('SIGKILL');
    await proc.exited;
  }
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

type WindowView = { start: unknown; count: unknown };

function windowsOf(connection: SseConnection): WindowView[] {
  return parseSse(connection.body())
    .filter((event) => event.event === 'window')
    .map((event) => {
      const parsed = JSON.parse(event.data.join('\n')) as unknown;
      const record =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      return { start: record['start'], count: record['count'] };
    });
}

afterAll(async () => {
  for (const connection of connections) {
    connection.request.destroy();
  }
  for (const proc of procs) {
    await stopProc(proc);
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

describe('phargus serve: a real agent-instrumented app piped in', () => {
  it(
    "AC-5: an app started with --import of the built agent, its stdout piped into serve --port 0 together with plain-text log lines, yields a window event from the real agent's samples",
    async () => {
      await ensureFreshDist();
      // The app runs from an empty directory so no phargus.config.* steers its agent.
      const appDir = mkdtempSync(join(tmpdir(), 'phargus-ac5-app-'));
      tempDirs.push(appDir);

      const cliChild = spawn(process.execPath, [BIN, 'serve', '--port', '0'], {
        cwd: repoRoot,
        env: cleanEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cli = track(cliChild);
      cliChild.stdout.resume();
      cliChild.stdin.on('error', (err) => cli.notes.push(`child stdin error: ${err.message}`));

      const appChild = spawn(
        process.execPath,
        ['--import', pathToFileURL(AGENT_ENTRY).href, '-e', APP_SOURCE],
        { cwd: appDir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const app = track(appChild);
      const piped = pipeline(appChild.stdout, cliChild.stdin).catch((err: unknown) => {
        app.notes.push(`pipe error: ${err instanceof Error ? err.message : String(err)}`);
      });

      const what = (): string => `${describeProc('cli', cli)}\n${describeProc('app', app)}`;
      const match = await waitForStderr(cli, URL_LINE, STARTUP_TIMEOUT_MS, what);
      const port = Number(match[1]);
      expect(port, what()).toBeGreaterThan(0);

      const sse = await openEvents(port);
      expect(sse.statusCode, what()).toBe(200);

      const startedAt = Date.now();
      const deadline = startedAt + EVENT_TIMEOUT_MS;
      while (windowsOf(sse).length === 0) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for a window event\nSSE body:\n${sse.body()}\n${what()}`,
          );
        }
        await sleep(50);
      }

      const [first] = windowsOf(sse);
      expect(typeof first?.count, what()).toBe('number');
      expect(Number(first?.count), what()).toBeGreaterThanOrEqual(1);
      expect(typeof first?.start, what()).toBe('number');
      // Real samples carry wall-clock timestamps, so the window starts close to now.
      expect(Math.abs(Number(first?.start) - startedAt), what()).toBeLessThan(600_000);

      await stopProc(app);
      await piped;
    },
    TEST_TIMEOUT_MS,
  );
});
