import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const agentDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(agentDir, '..', '..');

interface GcSampleShape {
  count: number;
  totalPause: number;
  maxPause: number;
  kinds: { minor: number; major: number; incremental: number; weakcb: number };
}

const KINDS = ['minor', 'major', 'incremental', 'weakcb'] as const;

function compileAgent(outDir: string): void {
  const tscPath = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const compile = spawnSync(
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
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--skipLibCheck',
      '--types',
      'node',
      '--declaration',
      'false',
      '--sourceMap',
      'false',
      join(agentDir, 'index.ts'),
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  );
  expect(
    existsSync(join(outDir, 'index.js')),
    `compiling the agent entrypoint failed:\n${compile.stdout}\n${compile.stderr}`,
  ).toBe(true);
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'module' }));
}

function expectZeroWindow(sample: GcSampleShape, label: string): void {
  expect(sample.count, `${label}: count`).toBe(0);
  expect(sample.totalPause, `${label}: totalPause`).toBe(0);
  expect(sample.maxPause, `${label}: maxPause`).toBe(0);
  for (const kind of KINDS) {
    expect(sample.kinds[kind], `${label}: kinds.${kind}`).toBe(0);
  }
}

function expectNonNegativeInt(value: unknown, label: string): void {
  expect(typeof value, `${label} is a number`).toBe('number');
  expect(Number.isInteger(value), `${label} is an integer (got ${String(value)})`).toBe(true);
  expect(value as number, `${label} is non-negative`).toBeGreaterThanOrEqual(0);
}

describe('agent GC events — AC-1', () => {
  it('AC-1: a GC sampler reads zeros, then counts a forced GC with integer pauses and kinds, then reads zeros again', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'argus-gc-ac1-'));
    try {
      compileAgent(outDir);
      writeFileSync(
        join(outDir, 'child.mjs'),
        [
          "import { createGcSampler } from './index.js';",
          'const sampler = createGcSampler();',
          'sampler.enable();',
          'const first = sampler.sample();',
          'globalThis.gc();',
          'globalThis.gc();',
          // GC entries reach the observer asynchronously: wait a few macrotasks.
          'await new Promise((r) => setTimeout(r, 100));',
          'const second = sampler.sample();',
          'const third = sampler.sample();',
          'sampler.disable();',
          'process.stdout.write(JSON.stringify({ first, second, third }) + "\\n");',
          '',
        ].join('\n'),
      );

      const child = spawnSync(process.execPath, ['--expose-gc', join(outDir, 'child.mjs')], {
        cwd: outDir,
        encoding: 'utf8',
        timeout: 15_000,
      });

      expect(child.error, `child failed to run: ${String(child.error)}`).toBeUndefined();
      expect(child.status, `child exited non-zero:\n${child.stderr}`).toBe(0);

      const lines = child.stdout.trim().split('\n');
      const last = lines[lines.length - 1] ?? '';
      const parsed = JSON.parse(last) as {
        first: GcSampleShape;
        second: GcSampleShape;
        third: GcSampleShape;
      };

      // First read: no GC delivered yet — an all-zero window.
      expectZeroWindow(parsed.first, 'first read');

      // Second read: the forced GC is counted.
      const second = parsed.second;
      expectNonNegativeInt(second.count, 'second.count');
      expect(second.count).toBeGreaterThanOrEqual(1);
      expectNonNegativeInt(second.totalPause, 'second.totalPause');
      expectNonNegativeInt(second.maxPause, 'second.maxPause');
      expect(second.maxPause).toBeLessThanOrEqual(second.totalPause);
      for (const kind of KINDS) {
        expectNonNegativeInt(second.kinds[kind], `second.kinds.${kind}`);
      }

      // Third read, no GC in between: the window was reset.
      expectZeroWindow(parsed.third, 'third read');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 150_000);
});
