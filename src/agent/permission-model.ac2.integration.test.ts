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
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const agentDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(agentDir, '..', '..');
const tscPath = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const INTERVAL_MS = 50;
const MARKER = 'ac2-app-loaded-marker';
const DISABLED_PREFIX = '[argus] agent disabled:';

function agentSources(): string[] {
  return readdirSync(agentDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map((f) => join(agentDir, f));
}

/** Compiles src/agent to CommonJS — what `--require argus/agent` loads through the `require` condition. */
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
  const pkgDir = realpathSync(mkdtempSync(join(tmpdir(), 'argus-perm-ac2-')));
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

// Preloaded with --require argus/agent: prints a marker, then runs briefly and ends on its own.
const APP = [
  `console.log(${JSON.stringify(MARKER)});`,
  'const intervalMs = Number(process.argv[2]);',
  'const until = Date.now() + intervalMs * 12;',
  'let sink = 0;',
  'const tick = () => {',
  '  for (let i = 0; i < 20000; i += 1) sink += i;',
  '  if (Date.now() < until) setTimeout(tick, 5);',
  '};',
  'tick();',
  '',
].join('\n');

function runChild(
  root: string,
  outFile: string,
  writeGrant: string | undefined,
): SpawnSyncReturns<string> {
  const app = join(root, 'ac2-app.cjs');
  writeFileSync(app, APP);
  const flags = ['--permission', `--allow-fs-read=${root}`];
  if (writeGrant !== undefined) {
    flags.push(`--allow-fs-write=${writeGrant}`);
  }
  return spawnSync(
    process.execPath,
    [...flags, '--require', 'argus/agent', app, String(INTERVAL_MS)],
    {
      cwd: root,
      env: childEnv({ ARGUS_OUTPUT: outFile, ARGUS_INTERVAL_MS: String(INTERVAL_MS) }),
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
}

function stderrLines(child: SpawnSyncReturns<string>): string[] {
  return child.stderr.split('\n').filter((l) => l.length > 0);
}

describe('argus/agent NDJSON file export under --permission — AC-2', () => {
  it('AC-2: with an fs-write grant the NDJSON file gets JSON lines and the agent stays enabled; without it no file is written, exactly one "[argus] agent disabled:" stderr line appears, the app still prints its marker and exits 0', () => {
    const root = tempPackage();

    // With --allow-fs-write granting the output file's directory.
    const grantedDir = join(root, 'out-granted');
    mkdirSync(grantedDir, { recursive: true });
    const grantedFile = join(grantedDir, 'out.ndjson');
    rmSync(grantedFile, { force: true });
    const granted = runChild(root, grantedFile, grantedDir);

    expect(granted.error, `granted child failed to run: ${String(granted.error)}`).toBeUndefined();
    expect(granted.signal, `granted child was killed:\n${granted.stderr}`).toBeNull();
    expect(
      stderrLines(granted).filter((l) => l.startsWith('[argus] agent disabled')),
      `granted child stderr:\n${granted.stderr}`,
    ).toEqual([]);
    expect(existsSync(grantedFile), `the agent wrote ${grantedFile}`).toBe(true);
    const lines = readFileSync(grantedFile, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    const parsed = lines.filter((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
    expect(parsed.length, 'at least one line parses as JSON').toBeGreaterThanOrEqual(1);

    // With no fs-write grant at all.
    const deniedDir = join(root, 'out-denied');
    mkdirSync(deniedDir, { recursive: true });
    const deniedFile = join(deniedDir, 'out.ndjson');
    rmSync(deniedFile, { force: true });
    const denied = runChild(root, deniedFile, undefined);

    expect(denied.error, `denied child failed to run: ${String(denied.error)}`).toBeUndefined();
    expect(denied.signal, `denied child was killed:\n${denied.stderr}`).toBeNull();
    expect(existsSync(deniedFile), `no output file at ${deniedFile}`).toBe(false);
    const disabledLines = stderrLines(denied).filter((l) => l.startsWith(DISABLED_PREFIX));
    expect(
      disabledLines.length,
      `exactly one "${DISABLED_PREFIX}" line; stderr:\n${denied.stderr}`,
    ).toBe(1);
    // The SPEC's intent: the denial surfaces as Argus's typed permission error (scope and resource),
    // not as Node's raw ERR_ACCESS_DENIED message, which names neither.
    const disabledLine = disabledLines[0] as string;
    expect(disabledLine, 'the disabled line names the denied scope').toContain('fs.write');
    expect(disabledLine, 'the disabled line names the absolute output path').toContain(deniedFile);
    expect(denied.stdout, 'the app printed its marker').toContain(MARKER);
    expect(denied.status, `denied child exit code; stderr:\n${denied.stderr}`).toBe(0);
  }, 300_000);
});
