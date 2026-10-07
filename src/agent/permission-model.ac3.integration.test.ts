import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
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

/** Compiles src/agent to CommonJS — what `require('argus/agent')` loads through the `require` condition. */
function compileCjs(sources: string[], outDir: string): void {
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
      '--module',
      'CommonJS',
      '--moduleResolution',
      'Node10',
      '--ignoreDeprecations',
      '6.0',
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
      `compiling ${source} (commonjs) failed:\n${result.stdout}\n${result.stderr}`,
    ).toBe(true);
  }
  writeFileSync(join(outDir, '..', 'package.json'), JSON.stringify({ type: 'commonjs' }));
}

/** A private copy of the package named "argus" (real `exports`), under a realpath'd temp root. */
function buildTempPackage(): string {
  const pkgDir = realpathSync(mkdtempSync(join(tmpdir(), 'argus-perm-ac3-')));
  const cjsDir = join(pkgDir, 'dist', 'cjs', 'agent');
  mkdirSync(cjsDir, { recursive: true });
  compileCjs(agentSources(), cjsDir);
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

// Calls takeHeapSnapshot({ dir }) through the package entry and prints the outcome as one JSON line.
const APP = [
  "const agent = require('argus/agent');",
  'const dir = process.argv[2];',
  'agent.takeHeapSnapshot({ dir }).then(',
  '  (result) => {',
  '    console.log(JSON.stringify({ ok: true, path: result.path }));',
  '  },',
  '  (err) => {',
  '    const Typed = agent.ArgusPermissionError;',
  '    console.log(',
  '      JSON.stringify({',
  '        ok: false,',
  "        isPermissionError: typeof Typed === 'function' && err instanceof Typed,",
  '        name: err && err.name,',
  '        message: err && err.message,',
  '        scope: err && err.scope,',
  '        resource: err && err.resource,',
  '      }),',
  '    );',
  '  },',
  ');',
  '',
].join('\n');

interface Outcome {
  ok: boolean;
  path?: unknown;
  isPermissionError?: unknown;
  name?: unknown;
  message?: unknown;
  scope?: unknown;
  resource?: unknown;
}

function runChild(
  root: string,
  dir: string,
  writeGrant: string | undefined,
): SpawnSyncReturns<string> {
  const app = join(root, 'ac3-app.cjs');
  writeFileSync(app, APP);
  const flags = ['--permission', `--allow-fs-read=${root}`];
  if (writeGrant !== undefined) {
    flags.push(`--allow-fs-write=${writeGrant}`);
  }
  return spawnSync(process.execPath, [...flags, app, dir], {
    cwd: root,
    env: childEnv({ ARGUS_OUTPUT: 'none' }),
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function outcomeOf(child: SpawnSyncReturns<string>, label: string): Outcome {
  const lines = child.stdout.split('\n').filter((l) => l.startsWith('{'));
  expect(
    lines.length,
    `${label} printed its outcome; stdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
  ).toBeGreaterThanOrEqual(1);
  return JSON.parse(lines[lines.length - 1] as string) as Outcome;
}

function snapshotFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.heapsnapshot'));
}

describe('argus/agent takeHeapSnapshot under --permission — AC-3', () => {
  it('AC-3: with an fs-write grant for the directory the snapshot is written inside it; without one the call rejects with the typed permission error (scope fs.write, absolute resource inside the directory), no .heapsnapshot is left and the child exits 0', () => {
    const root = tempPackage();

    // With --allow-fs-write granting the snapshot directory.
    const grantedDir = join(root, 'snaps-granted');
    mkdirSync(grantedDir, { recursive: true });
    const granted = runChild(root, grantedDir, grantedDir);
    expect(granted.error, `granted child failed to run: ${String(granted.error)}`).toBeUndefined();
    expect(granted.signal, `granted child was killed:\n${granted.stderr}`).toBeNull();
    const grantedOutcome = outcomeOf(granted, 'granted child');
    expect(grantedOutcome.ok, `granted outcome: ${JSON.stringify(grantedOutcome)}`).toBe(true);
    expect(typeof grantedOutcome.path).toBe('string');
    const snapPath = grantedOutcome.path as string;
    expect(
      resolve(snapPath).startsWith(grantedDir + sep),
      `${snapPath} is inside ${grantedDir}`,
    ).toBe(true);
    expect(snapPath.endsWith('.heapsnapshot'), `${snapPath} ends in .heapsnapshot`).toBe(true);
    expect(existsSync(snapPath), `${snapPath} exists`).toBe(true);

    // With no fs-write grant at all.
    const deniedDir = join(root, 'snaps-denied');
    mkdirSync(deniedDir, { recursive: true });
    const denied = runChild(root, deniedDir, undefined);
    expect(denied.error, `denied child failed to run: ${String(denied.error)}`).toBeUndefined();
    expect(denied.signal, `denied child was killed:\n${denied.stderr}`).toBeNull();
    const deniedOutcome = outcomeOf(denied, 'denied child');
    expect(deniedOutcome.ok, `denied outcome: ${JSON.stringify(deniedOutcome)}`).toBe(false);
    expect(
      deniedOutcome.isPermissionError,
      `the rejection is the typed permission error: ${JSON.stringify(deniedOutcome)}`,
    ).toBe(true);
    expect(deniedOutcome.scope).toBe('fs.write');
    expect(typeof deniedOutcome.resource).toBe('string');
    const resource = deniedOutcome.resource as string;
    expect(isAbsolute(resource), `${resource} is absolute`).toBe(true);
    expect(resource.startsWith(deniedDir + sep), `${resource} is inside ${deniedDir}`).toBe(true);
    expect(snapshotFilesIn(deniedDir), 'no .heapsnapshot file left behind').toEqual([]);
    expect(denied.status, `denied child exit code; stderr:\n${denied.stderr}`).toBe(0);
  }, 300_000);
});
