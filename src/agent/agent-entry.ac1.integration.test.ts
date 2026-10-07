import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const agentDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(agentDir, '..', '..');
const tscPath = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const INTERVAL_MS = 25;

function agentSources(): string[] {
  return readdirSync(agentDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map((f) => join(agentDir, f));
}

function compile(sources: string[], outDir: string, moduleArgs: string[], type: string): void {
  const result = spawnSync(
    process.execPath,
    [
      tscPath,
      // TS 6 refuses command-line files while a tsconfig.json is present (TS5112).
      '--ignoreConfig',
      '--outDir',
      outDir,
      '--rootDir',
      agentDir,
      ...moduleArgs,
      '--target',
      'ES2022',
      '--skipLibCheck',
      '--types',
      'node',
      '--declaration',
      'false',
      '--sourceMap',
      'false',
      ...sources,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  );
  for (const source of sources) {
    const emitted = join(outDir, basename(source).replace(/\.ts$/, '.js'));
    expect(
      existsSync(emitted),
      `compiling ${source} (${type}) failed:\n${result.stdout}\n${result.stderr}`,
    ).toBe(true);
  }
  writeFileSync(join(outDir, '..', 'package.json'), JSON.stringify({ type }));
}

/** A private copy of the package: both builds of src/agent and the real `exports`, named "argus". */
function buildTempPackage(): string {
  const pkgDir = mkdtempSync(join(tmpdir(), 'argus-entry-ac1-'));
  const sources = agentSources();
  const esmDir = join(pkgDir, 'dist', 'esm', 'agent');
  const cjsDir = join(pkgDir, 'dist', 'cjs', 'agent');
  mkdirSync(esmDir, { recursive: true });
  mkdirSync(cjsDir, { recursive: true });
  compile(sources, esmDir, ['--module', 'NodeNext', '--moduleResolution', 'NodeNext'], 'module');
  compile(
    sources,
    cjsDir,
    ['--module', 'CommonJS', '--moduleResolution', 'Node10', '--ignoreDeprecations', '6.0'],
    'commonjs',
  );
  const realPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    exports: unknown;
  };
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: 'argus',
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: realPkg.exports,
    }),
  );
  return pkgDir;
}

let pkgDir: string | undefined;
function tempPackage(): string {
  pkgDir ??= buildTempPackage();
  return pkgDir;
}

afterAll(() => {
  if (pkgDir !== undefined) {
    rmSync(pkgDir, { recursive: true, force: true });
  }
});

/** The child's env: the parent's minus every ARGUS_* name (an unknown one warns on stderr). */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith('ARGUS_') || name === 'NODE_OPTIONS') {
      continue;
    }
    env[name] = value;
  }
  return { ...env, ...extra };
}

const APP = [
  '// Keeps itself busy for about ten sampling intervals, then lets its event loop empty.',
  'const intervalMs = Number(process.argv[2]);',
  'const until = Date.now() + intervalMs * 10;',
  'let sink = 0;',
  'function tick() {',
  '  for (let i = 0; i < 20000; i += 1) sink += i;',
  '  if (Date.now() < until) setTimeout(tick, Math.max(1, Math.floor(intervalMs / 5)));',
  '}',
  'tick();',
  'let said = false;',
  "process.on('beforeExit', () => {",
  '  if (said) return;',
  '  said = true;',
  "  console.log('app done ' + String(sink > 0));",
  '});',
  '',
].join('\n');

function writeApp(dir: string): string {
  const app = join(dir, 'ac1-app.mjs');
  writeFileSync(app, APP);
  return app;
}

function runChild(
  dir: string,
  preload: '--require' | '--import',
  env: Record<string, string>,
): SpawnSyncReturns<string> {
  const app = writeApp(dir);
  return spawnSync(process.execPath, [preload, 'argus/agent', app, String(INTERVAL_MS)], {
    cwd: dir,
    env: childEnv(env),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function expectCleanExit(child: SpawnSyncReturns<string>): void {
  expect(child.error, `child failed to run: ${String(child.error)}`).toBeUndefined();
  expect(child.signal, `child was killed (did not exit on its own):\n${child.stderr}`).toBeNull();
  expect(child.status, `child exited non-zero:\n${child.stderr}`).toBe(0);
  expect(child.stderr).toBe('');
}

function expectSampleLine(line: string): void {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  expect(Number.isInteger(parsed['timestamp']), `integer timestamp in ${line}`).toBe(true);
  for (const part of ['eventLoop', 'memory', 'gc', 'backpressure']) {
    expect(parsed, `sample has a ${part} part`).toHaveProperty(part);
    expect(parsed[part], `sample ${part} part is present`).not.toBeUndefined();
  }
}

function expectNdjsonFile(file: string): void {
  expect(existsSync(file), `the agent wrote ${file}`).toBe(true);
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
  expect(lines.length, 'at least one NDJSON sample line').toBeGreaterThanOrEqual(1);
  for (const line of lines) {
    expectSampleLine(line);
  }
}

describe('argus/agent entry — AC-1', () => {
  it('AC-1: node --require argus/agent streams NDJSON samples to the ARGUS_OUTPUT file and the app exits 0 on its own', () => {
    const dir = tempPackage();
    const outFile = join(dir, 'require-out.ndjson');
    rmSync(outFile, { force: true });
    const child = runChild(dir, '--require', {
      ARGUS_OUTPUT: outFile,
      ARGUS_INTERVAL_MS: String(INTERVAL_MS),
    });
    expectCleanExit(child);
    expectNdjsonFile(outFile);
  }, 300_000);

  it('AC-1: node --import argus/agent streams NDJSON samples to the ARGUS_OUTPUT file and the app exits 0 on its own', () => {
    const dir = tempPackage();
    const outFile = join(dir, 'import-out.ndjson');
    rmSync(outFile, { force: true });
    const child = runChild(dir, '--import', {
      ARGUS_OUTPUT: outFile,
      ARGUS_INTERVAL_MS: String(INTERVAL_MS),
    });
    expectCleanExit(child);
    expectNdjsonFile(outFile);
  }, 300_000);

  it("AC-1: node --require argus/agent with ARGUS_OUTPUT=stdout prints samples and still prints the app's last console.log after them", () => {
    const dir = tempPackage();
    const child = runChild(dir, '--require', {
      ARGUS_OUTPUT: 'stdout',
      ARGUS_INTERVAL_MS: String(INTERVAL_MS),
    });
    expectCleanExit(child);
    const lines = child.stdout.split('\n').filter((l) => l.length > 0);
    expect(lines[lines.length - 1], `stdout:\n${child.stdout}`).toBe('app done true');
    const samples = lines.slice(0, -1);
    expect(samples.length, 'at least one sample line before the app line').toBeGreaterThanOrEqual(
      1,
    );
    for (const line of samples) {
      expectSampleLine(line);
    }
  }, 300_000);
});
