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
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_ID}-01`;

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
  const pkgDir = mkdtempSync(join(tmpdir(), 'argus-span-export-ac1-'));
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
  "import { createServer, request } from 'node:http';",
  '',
  '// Serves three requests on a local server, closes it, stays alive for about ten sampling',
  '// intervals, then lets its event loop empty and exits on its own.',
  'const intervalMs = Number(process.argv[2]);',
  'const traceparent = process.argv[3];',
  '',
  'const server = createServer((req, res) => {',
  "  res.statusCode = String(req.url).startsWith('/missing') ? 404 : 200;",
  "  res.end('ok');",
  '});',
  '',
  'function send(port, path, headers) {',
  '  return new Promise((resolve, reject) => {',
  '    const req = request(',
  "      { host: '127.0.0.1', port, path, method: 'GET', headers, agent: false },",
  '      (res) => {',
  "        res.on('error', reject);",
  "        res.on('end', () => resolve(res.statusCode));",
  '        res.resume();',
  '      },',
  '    );',
  "    req.on('error', reject);",
  '    req.end();',
  '  });',
  '}',
  '',
  'async function main() {',
  '  const port = server.address().port;',
  '  const statuses = [];',
  "  statuses.push(await send(port, '/items?q=1', {}));",
  "  statuses.push(await send(port, '/missing', {}));",
  "  statuses.push(await send(port, '/traced', { traceparent }));",
  '  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));',
  "  console.log('statuses ' + statuses.join(','));",
  '  setTimeout(() => {}, intervalMs * 10);',
  '}',
  '',
  "server.listen(0, '127.0.0.1', () => {",
  '  main().catch((err) => {',
  '    process.exitCode = 1;',
  '    throw err;',
  '  });',
  '});',
  '',
].join('\n');

function runChild(dir: string, outFile: string): SpawnSyncReturns<string> {
  const app = join(dir, 'ac1-span-app.mjs');
  writeFileSync(app, APP);
  return spawnSync(
    process.execPath,
    ['--import', 'argus/agent', app, String(INTERVAL_MS), TRACEPARENT],
    {
      cwd: dir,
      env: childEnv({ ARGUS_OUTPUT: outFile, ARGUS_INTERVAL_MS: String(INTERVAL_MS) }),
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
}

function expectCleanExit(child: SpawnSyncReturns<string>): void {
  expect(child.error, `child failed to run: ${String(child.error)}`).toBeUndefined();
  expect(child.signal, `child was killed (did not exit on its own):\n${child.stderr}`).toBeNull();
  expect(child.status, `child exited non-zero:\n${child.stderr}`).toBe(0);
  expect(child.stderr).toBe('');
}

function readLines(file: string): Array<Record<string, unknown>> {
  expect(existsSync(file), `the agent wrote ${file}`).toBe(true);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('agent span export over NDJSON — AC-1', () => {
  it('AC-1: node --import argus/agent writes one span line per HTTP request to the ARGUS_OUTPUT file, beside unchanged sample lines', () => {
    pkgDir ??= buildTempPackage();
    const outFile = join(pkgDir, 'spans-out.ndjson');
    const child = runChild(pkgDir, outFile);
    expectCleanExit(child);
    expect(child.stdout).toContain('statuses 200,404,200');

    const records = readLines(outFile);
    const spans = records.filter((r) => r['type'] === 'span');
    expect(spans, `span lines in:\n${readFileSync(outFile, 'utf8')}`).toHaveLength(3);

    const expected = [
      { name: 'GET /items', statusCode: 200 },
      { name: 'GET /missing', statusCode: 404 },
      { name: 'GET /traced', statusCode: 200 },
    ];
    for (const want of expected) {
      const matching = spans.filter((s) => s['name'] === want.name);
      expect(matching, `exactly one span named ${want.name}`).toHaveLength(1);
      const span = matching[0] ?? {};
      expect(span['statusCode']).toBe(want.statusCode);
      expect(String(span['traceId'])).toMatch(/^[0-9a-f]{32}$/);
      expect(typeof span['traceId']).toBe('string');
      expect(String(span['spanId'])).toMatch(/^[0-9a-f]{16}$/);
      expect(typeof span['spanId']).toBe('string');
      expect(Number.isInteger(span['startTimeMs']), `integer startTimeMs on ${want.name}`).toBe(
        true,
      );
      expect(Number.isInteger(span['durationNs']), `integer durationNs on ${want.name}`).toBe(true);
      expect(span['durationNs'] as number).toBeGreaterThanOrEqual(0);
    }

    const spanIds = new Set(spans.map((s) => s['spanId']));
    expect(spanIds.size, 'the three span ids are distinct').toBe(3);

    const traced = spans.find((s) => s['name'] === 'GET /traced');
    expect(traced?.['traceId']).toBe(TRACE_ID);
    expect(traced?.['spanId']).not.toBe(PARENT_ID);

    const samples = records.filter((r) => !Object.prototype.hasOwnProperty.call(r, 'type'));
    expect(samples.length, 'at least one sample line with no type field').toBeGreaterThanOrEqual(1);
    for (const sample of samples) {
      expect(Number.isInteger(sample['timestamp']), 'integer sample timestamp').toBe(true);
      for (const part of ['eventLoop', 'memory', 'heapSpaces', 'gc', 'backpressure']) {
        expect(sample, `sample has a ${part} part`).toHaveProperty(part);
        expect(sample[part], `sample ${part} part is present`).not.toBeUndefined();
      }
    }
    expect(records.length).toBe(spans.length + samples.length);
  }, 300_000);
});
