import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Child-process regression tests for F-01 and F-12 (production-readiness audit):
//  - the dual-package hazard: an ESM copy and a CJS copy of the agent, each enabling a probe and
//    disabling it in either order, must leave every write working and the prototypes restored;
//  - a throwing onSample with the default reporting path warns once and does not crash the process.

const agentDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(agentDir, '..', '..');
const entries = ['backpressure-probe.ts', 'http-tracing.ts', 'sampler-controller.ts'];

let outDir = '';

function compile(dir: string, moduleArgs: string[]): void {
  const tscPath = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(
    process.execPath,
    [
      tscPath,
      // TS 6 refuses command-line files while a tsconfig.json is present (TS5112).
      '--ignoreConfig',
      '--outDir',
      dir,
      '--rootDir',
      agentDir,
      ...moduleArgs,
      '--target',
      'ES2022',
      '--strict',
      '--skipLibCheck',
      '--types',
      'node',
      '--declaration',
      'false',
      '--sourceMap',
      'false',
      ...entries.map((entry) => join(agentDir, entry)),
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  );
  expect(
    existsSync(join(dir, 'backpressure-probe.js')),
    `compiling the agent failed:\n${result.stdout}\n${result.stderr}`,
  ).toBe(true);
}

function runChild(script: string): { status: number | null; stdout: string; stderr: string } {
  const file = join(outDir, `child-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, script);
  const child = spawnSync(process.execPath, [file], {
    cwd: outDir,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(child.error, `child failed to run: ${String(child.error)}`).toBeUndefined();
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'argus-patch-'));
  const esmDir = join(outDir, 'esm');
  const cjsDir = join(outDir, 'cjs');
  compile(esmDir, ['--module', 'NodeNext', '--moduleResolution', 'NodeNext']);
  writeFileSync(join(esmDir, 'package.json'), JSON.stringify({ type: 'module' }));
  compile(cjsDir, [
    '--module',
    'CommonJS',
    '--moduleResolution',
    'Node10',
    '--ignoreDeprecations',
    '6.0',
  ]);
  writeFileSync(join(cjsDir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
}, 240_000);

afterAll(() => {
  if (outDir !== '') {
    rmSync(outDir, { recursive: true, force: true });
  }
});

describe('prototype patch safety across an ESM and a CJS copy (F-01)', () => {
  it('enabling a probe in each copy and disabling in either order keeps writes working and restores the prototypes', () => {
    const script = `
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { OutgoingMessage, Server } from 'node:http';
import { Duplex, PassThrough, Writable } from 'node:stream';
const require = createRequire(import.meta.url);
const esm = await import('./esm/backpressure-probe.js');
const cjs = require('./cjs/backpressure-probe.js');
const esmTracing = await import('./esm/http-tracing.js');
const cjsTracing = require('./cjs/http-tracing.js');
const targets = [Writable.prototype, Duplex.prototype, OutgoingMessage.prototype];
const pristine = targets.map((t) => t.write);
const pristineEmit = Object.getOwnPropertyDescriptor(Server.prototype, 'emit');

async function stall() {
  const s = new Writable({ highWaterMark: 1, write(_c, _e, cb) { setTimeout(cb, 2); } });
  while (s.write('x')) {}
  await once(s, 'drain');
}
function tryWrites() {
  const errors = [];
  for (const make of [
    () => new Writable({ write(_c, _e, cb) { cb(); } }),
    () => new Duplex({ write(_c, _e, cb) { cb(); }, read() {} }),
    () => new PassThrough(),
  ]) {
    try { make().write('hello'); } catch (error) { errors.push(String(error && error.message)); }
  }
  return errors;
}

const results = [];
for (const order of ['esm-first', 'cjs-first']) {
  const a = esm.createBackpressureProbe();
  const b = cjs.createBackpressureProbe();
  a.enable();
  b.enable();
  esmTracing.enable();
  cjsTracing.enable();
  await stall();
  const events = [a.sample().events, b.sample().events];
  const [first, second] = order === 'esm-first' ? [a, b] : [b, a];
  const [firstT, secondT] = order === 'esm-first' ? [esmTracing, cjsTracing] : [cjsTracing, esmTracing];
  first.disable();
  firstT.disable();
  const midErrors = tryWrites();
  second.disable();
  secondT.disable();
  const errors = tryWrites();
  const restored = targets.every((t, i) => t.write === pristine[i]);
  const emitRestored =
    JSON.stringify(Object.getOwnPropertyDescriptor(Server.prototype, 'emit')) === JSON.stringify(pristineEmit);
  results.push({ order, events, midErrors, errors, restored, emitRestored });
}
process.stdout.write(JSON.stringify(results));
`;
    const child = runChild(script);
    expect(child.status, `child exited non-zero:\n${child.stderr}`).toBe(0);
    const results = JSON.parse(child.stdout) as unknown;
    expect(results).toEqual([
      {
        order: 'esm-first',
        events: [1, 1],
        midErrors: [],
        errors: [],
        restored: true,
        emitRestored: true,
      },
      {
        order: 'cjs-first',
        events: [1, 1],
        midErrors: [],
        errors: [],
        restored: true,
        emitRestored: true,
      },
    ]);
  }, 60_000);
});

describe('sampler controller default failure reporting (F-12)', () => {
  it('a throwing onSample without onError warns once, keeps ticking and does not crash the process', () => {
    const script = `
import { createSamplerController } from './esm/sampler-controller.js';
let ticks = 0;
const controller = createSamplerController(() => {
  ticks += 1;
  throw new Error('onSample exploded');
});
controller.start(10);
const deadline = Date.now() + 5000;
while (ticks < 3 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10));
}
controller.stop();
process.stdout.write(JSON.stringify({ ticks }));
`;
    const child = runChild(script);
    expect(child.status, `child exited non-zero:\n${child.stderr}`).toBe(0);
    const { ticks } = JSON.parse(child.stdout) as { ticks: number };
    expect(ticks).toBeGreaterThanOrEqual(3);
    const warnings = child.stderr.match(
      /ArgusSamplerWarning: sampler tick failed: onSample exploded/g,
    );
    expect(warnings, child.stderr).toHaveLength(1);
  }, 60_000);
});
