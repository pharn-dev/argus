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

const INTERVAL_MS = 50;
const EXPORTS = ['loadAgentConfig', 'createSamplerController', 'createNdjsonExporter'];

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
  const pkgDir = mkdtempSync(join(tmpdir(), 'argus-entry-ac2-'));
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

// Preloaded with --require argus/agent; loads the entry twice more with require() and once with import().
const APP = [
  "const first = require('argus/agent');",
  "const second = require('argus/agent');",
  'const intervalMs = Number(process.argv[2]);',
  `const names = ${JSON.stringify(EXPORTS)};`,
  "import('argus/agent').then((esm) => {",
  '  for (const name of names) {',
  "    console.log('cjs ' + name + ' ' + String(typeof first[name] === 'function' && typeof second[name] === 'function'));",
  "    console.log('esm ' + name + ' ' + String(typeof esm[name] === 'function'));",
  '  }',
  '  const until = Date.now() + intervalMs * 12;',
  '  let sink = 0;',
  '  const tick = () => {',
  '    for (let i = 0; i < 20000; i += 1) sink += i;',
  '    if (Date.now() < until) setTimeout(tick, 5);',
  '  };',
  '  tick();',
  '}, (err) => {',
  "  console.error('import failed', err);",
  '  process.exitCode = 1;',
  '});',
  '',
].join('\n');

function runChild(dir: string, env: Record<string, string>): SpawnSyncReturns<string> {
  const app = join(dir, 'ac2-app.cjs');
  writeFileSync(app, APP);
  return spawnSync(process.execPath, ['--require', 'argus/agent', app, String(INTERVAL_MS)], {
    cwd: dir,
    env: childEnv(env),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function expectExitAndExports(child: SpawnSyncReturns<string>): void {
  expect(child.error, `child failed to run: ${String(child.error)}`).toBeUndefined();
  expect(child.signal, `child was killed (did not exit on its own):\n${child.stderr}`).toBeNull();
  expect(child.status, `child exited non-zero:\n${child.stderr}`).toBe(0);
  for (const kind of ['cjs', 'esm']) {
    for (const name of EXPORTS) {
      expect(child.stdout, `${kind} ${name} is a function`).toContain(`${kind} ${name} true\n`);
    }
  }
}

describe('argus/agent entry — AC-2', () => {
  it('AC-2: loading argus/agent by --require, twice by require() and once by import() exposes the library exports, runs a single agent, and ARGUS_ENABLED=0 turns it off', () => {
    const dir = tempPackage();
    const outFile = join(dir, 'once-out.ndjson');
    rmSync(outFile, { force: true });
    const child = runChild(dir, {
      ARGUS_OUTPUT: outFile,
      ARGUS_INTERVAL_MS: String(INTERVAL_MS),
    });
    expectExitAndExports(child);

    expect(existsSync(outFile), `the agent wrote ${outFile}`).toBe(true);
    const timestamps = readFileSync(outFile, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => (JSON.parse(l) as { timestamp: number }).timestamp)
      .sort((a, b) => a - b);
    expect(timestamps.length, 'at least two samples').toBeGreaterThanOrEqual(2);
    for (let i = 1; i < timestamps.length; i += 1) {
      const gap = (timestamps[i] as number) - (timestamps[i - 1] as number);
      expect(
        gap,
        `samples ${String(i - 1)} and ${String(i)} are ${String(gap)} ms apart (one agent, not several): ${timestamps.join(', ')}`,
      ).toBeGreaterThanOrEqual(INTERVAL_MS / 2);
    }

    // The same app with ARGUS_ENABLED=0: exports still there, no samples written.
    const disabledFile = join(dir, 'disabled-out.ndjson');
    rmSync(disabledFile, { force: true });
    const disabled = runChild(dir, {
      ARGUS_OUTPUT: disabledFile,
      ARGUS_INTERVAL_MS: String(INTERVAL_MS),
      ARGUS_ENABLED: '0',
    });
    expectExitAndExports(disabled);
    const written = existsSync(disabledFile) ? readFileSync(disabledFile, 'utf8') : '';
    expect(written, 'with ARGUS_ENABLED=0 the output file is absent or empty').toBe('');
  }, 300_000);
});
