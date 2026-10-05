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
  const pkgDir = mkdtempSync(join(tmpdir(), 'argus-entry-ac3-'));
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

/** The child's env: the parent's minus every ARGUS_* name (the loader rejects unknown ones). */
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

function runChild(
  dir: string,
  preload: '--require' | '--import',
  env: Record<string, string>,
): SpawnSyncReturns<string> {
  const app = join(dir, 'ac3-app.mjs');
  writeFileSync(app, "console.log('app ran');\n");
  return spawnSync(process.execPath, [preload, 'argus/agent', app], {
    cwd: dir,
    env: childEnv(env),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function expectReportedOnceAndAppRan(child: SpawnSyncReturns<string>): void {
  expect(child.error, `child failed to run: ${String(child.error)}`).toBeUndefined();
  expect(child.signal, `child was killed:\n${child.stderr}`).toBeNull();
  expect(child.status, `child exited non-zero:\n${child.stderr}`).toBe(0);
  expect(child.stdout).toContain('app ran');

  const stderrLines = child.stderr.split('\n').filter((l) => l.length > 0);
  expect(stderrLines.length, `exactly one stderr line:\n${child.stderr}`).toBe(1);
  expect(stderrLines[0], `stderr:\n${child.stderr}`).toMatch(/^\[argus\]/);
  expect(child.stderr).not.toContain('UnhandledPromiseRejection');
  expect(child.stderr, 'no stack trace text').not.toMatch(/^\s+at\s/m);
}

const PRELOADS = ['--require', '--import'] as const;

describe('argus/agent entry — AC-3', () => {
  for (const preload of PRELOADS) {
    it(`AC-3: ${preload} argus/agent with an invalid config (ARGUS_INTERVAL_MS=abc) reports one [argus] line and the app still runs and exits 0`, () => {
      const dir = tempPackage();
      const child = runChild(dir, preload, { ARGUS_INTERVAL_MS: 'abc' });
      expectReportedOnceAndAppRan(child);
    }, 300_000);

    it(`AC-3: ${preload} argus/agent with an unusable output (a missing directory) reports one [argus] line and the app still runs and exits 0`, () => {
      const dir = tempPackage();
      const missing = join(dir, `missing-${preload.slice(2)}`, 'nested', 'out.ndjson');
      rmSync(join(dir, `missing-${preload.slice(2)}`), { recursive: true, force: true });
      const child = runChild(dir, preload, { ARGUS_OUTPUT: missing, ARGUS_INTERVAL_MS: '20' });
      expectReportedOnceAndAppRan(child);
    }, 300_000);
  }
});
