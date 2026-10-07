import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const srcDir = join(repoRoot, 'src');
const exampleDir = join(repoRoot, 'examples', 'express-app');
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
const EXIT_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 15_000;

const APP_LINE = /^\[express-app\] app listening on http:\/\/127\.0\.0\.1:(\d+)$/m;
const DASHBOARD_LINE = /^\[express-app\] dashboard listening on http:\/\/127\.0\.0\.1:(\d+)$/m;
const ARGUS_SUBPATH = /^argus\/[a-z-]+$/;
const SOURCE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.mts', '.cts'];

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

/** Resolves with the exit, or with undefined when the example has not exited within the bound. */
async function waitForExit(run: ExampleRun, timeoutMs: number): Promise<ExitInfo | undefined> {
  return Promise.race([run.exited, sleep(timeoutMs).then(() => undefined)]);
}

/** Sends SIGTERM (then SIGKILL after a bound) to a still-running example and waits for it to exit. */
async function stopExample(run: ExampleRun): Promise<void> {
  if (run.exitInfo() !== undefined) return;
  run.child.kill('SIGTERM');
  if ((await waitForExit(run, STOP_TIMEOUT_MS)) === undefined) {
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
        // The example closes this stream on shutdown; a reset then is recorded, not thrown.
        response.on('error', (err) => {
          errors.push(err.message);
        });
        done({
          request,
          statusCode: response.statusCode ?? 0,
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

/** Every source file under the directory, recursively (symbolic links are not followed). */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

function isIdentifierChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_' ||
    ch === '$' ||
    ch === '.'
  );
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Index of the last non-whitespace character at or before `index`, or -1. */
function lastNonSpace(source: string, index: number): number {
  let k = index;
  while (k >= 0 && isSpace(source[k])) k -= 1;
  return k;
}

/** True when `word` is a whole word ending at `endIndex`. */
function wordEndsAt(source: string, endIndex: number, word: string): boolean {
  const start = endIndex - word.length + 1;
  if (start < 0 || source.slice(start, endIndex + 1) !== word) return false;
  return !isIdentifierChar(source[start - 1]);
}

/** Whether a string literal opening at `quoteIndex` is a module specifier position. */
function isSpecifierPosition(source: string, quoteIndex: number): boolean {
  const before = lastNonSpace(source, quoteIndex - 1);
  if (before < 0) return false;
  if (wordEndsAt(source, before, 'from') || wordEndsAt(source, before, 'import')) return true;
  if (source[before] !== '(') return false;
  const callee = lastNonSpace(source, before - 1);
  return wordEndsAt(source, callee, 'import') || wordEndsAt(source, callee, 'require');
}

/**
 * The module specifiers of static imports and re-exports (`from '…'`), side-effect imports
 * (`import '…'`), dynamic `import('…')` and `require('…')`. A linear scan that skips comments and
 * reads string literals; no regular expression is involved.
 */
function moduleSpecifiers(source: string): string[] {
  const found: string[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end === -1 ? n : end + 1;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      let value = '';
      while (j < n && source[j] !== ch) {
        if (source[j] === '\\') {
          value += source[j + 1] ?? '';
          j += 2;
        } else {
          value += source[j] ?? '';
          j += 1;
        }
      }
      if (isSpecifierPosition(source, i)) found.push(value);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return found;
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

describe('examples/express-app: clean shutdown and dependency-free sources', () => {
  beforeAll(async () => {
    await ensureFreshDist();
  }, 180_000);

  it('AC-3: on SIGTERM the example exits with code 0 within a bounded time and its stderr has no agent-disabled line', async () => {
    const run = startExample();
    current = run;
    const { appPort, dashboardPort } = await waitForPorts(run, STARTUP_TIMEOUT_MS);

    // Shut down a running example: an SSE client is connected and a request has been served.
    const sse = await openSse(dashboardPort);
    connections.push(sse);
    expect(sse.statusCode, diagnostics(run)).toBe(200);
    expect(await httpGet(appPort, '/fast'), diagnostics(run)).toBe(200);

    run.child.kill('SIGTERM');
    const exit = await waitForExit(run, EXIT_TIMEOUT_MS);

    expect(
      exit,
      `the example did not exit within ${String(EXIT_TIMEOUT_MS)} ms\n${diagnostics(run)}`,
    ).toBeDefined();
    expect(exit?.error, diagnostics(run)).toBeUndefined();
    expect(exit?.signal, diagnostics(run)).toBeNull();
    expect(exit?.code, diagnostics(run)).toBe(0);
    expect(run.stderr()).not.toContain('[argus] agent disabled');
  }, 90_000);

  it('AC-3: the example imports Argus only through bare argus/<subpath> specifiers, never express, and its README documents build, run and Express', () => {
    const files = sourceFiles(exampleDir);
    expect(files.length, `source files under ${exampleDir}`).toBeGreaterThan(0);

    const all: string[] = [];
    for (const file of files) {
      const where = relative(repoRoot, file);
      for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
        all.push(specifier);
        expect(
          specifier.startsWith('node:') || ARGUS_SUBPATH.test(specifier),
          `${where} imports ${JSON.stringify(specifier)}`,
        ).toBe(true);
        expect(specifier, where).not.toContain('src/');
        expect(specifier, where).not.toContain('dist/');
        expect(specifier === 'express' || specifier.startsWith('express/'), where).toBe(false);
      }
    }
    // The one-line agent setup is itself an Argus import; a scan that found none proves nothing.
    expect(all).toContain('argus/agent');

    const readme = readFileSync(join(exampleDir, 'README.md'), 'utf8');
    expect(readme).toContain('npm run build');
    expect(readme).toContain('node examples/express-app/index.mjs');
    expect(readme).toContain('Express');
  });
});
