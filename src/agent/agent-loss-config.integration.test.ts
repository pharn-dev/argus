import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
  const pkgDir = mkdtempSync(join(tmpdir(), 'argus-loss-config-'));
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

/** The child's env: the parent's minus every ARGUS_* name and NODE_OPTIONS. */
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

const INTERVAL_MS = 20;

function runChild(
  dir: string,
  preload: '--require' | '--import',
  env: Record<string, string>,
): SpawnSyncReturns<string> {
  const app = join(dir, 'loss-config-app.mjs');
  // Stay alive for several sample intervals, then exit on its own.
  writeFileSync(app, "setTimeout(() => console.log('app ran'), 400);\n");
  return spawnSync(process.execPath, [preload, 'argus/agent', app], {
    cwd: dir,
    env: childEnv(env),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

type SampleLine = { timestamp: number; dropped?: { samples: unknown; spans: unknown } };

const PRELOADS = ['--require', '--import'] as const;

describe('argus/agent — unknown variables, loss accounting, output file mode', () => {
  for (const preload of PRELOADS) {
    it(`${preload}: ARGUS_FOO warns once and is ignored; the agent still starts and writes samples carrying dropped counters to a 0600 file`, () => {
      const dir = tempPackage();
      const output = join(dir, `out-${preload.slice(2)}.ndjson`);
      rmSync(output, { force: true });
      const child = runChild(dir, preload, {
        ARGUS_FOO: '1',
        ARGUS_OUTPUT: output,
        ARGUS_INTERVAL_MS: String(INTERVAL_MS),
      });

      expect(child.error, `child failed to run: ${String(child.error)}`).toBeUndefined();
      expect(child.signal, `child was killed:\n${child.stderr}`).toBeNull();
      expect(child.status, `child exited non-zero:\n${child.stderr}`).toBe(0);
      expect(child.stdout).toContain('app ran');

      const stderrLines = child.stderr.split('\n').filter((l) => l.length > 0);
      expect(stderrLines, `exactly one stderr line:\n${child.stderr}`).toHaveLength(1);
      expect(stderrLines[0]).toMatch(/^\[argus\] warning: /);
      expect(stderrLines[0]).toContain('ARGUS_FOO');
      expect(child.stderr).not.toContain('agent disabled');

      expect(existsSync(output), `no output file:\n${child.stderr}`).toBe(true);
      const samples = readFileSync(output, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as SampleLine);
      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples) {
        expect(sample.dropped).toEqual({ samples: 0, spans: 0 });
      }

      if (process.platform !== 'win32') {
        expect(statSync(output).mode & 0o777).toBe(0o600);
      }
    }, 300_000);
  }
});
