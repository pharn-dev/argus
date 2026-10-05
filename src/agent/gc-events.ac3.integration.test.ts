import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const agentDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(agentDir, '..', '..');

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

describe('agent GC events — AC-3', () => {
  it('AC-3: a process that starts the controller with its GC sampler, allocates and stops exits 0 on its own with no sample after stop', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'argus-gc-ac3-'));
    try {
      compileAgent(outDir);
      writeFileSync(
        join(outDir, 'child.mjs'),
        [
          "import { createSamplerController } from './index.js';",
          'let count = 0;',
          'let sawGc = false;',
          'const controller = createSamplerController((sample) => {',
          '  count += 1;',
          "  if (sample !== null && typeof sample === 'object' && typeof sample.gc === 'object' && sample.gc !== null) sawGc = true;",
          '});',
          'controller.start(20);',
          'setTimeout(() => {',
          '  let junk = [];',
          '  for (let i = 0; i < 2000; i += 1) junk.push(new Array(1000).fill(i));',
          '  junk = null;',
          '  controller.stop();',
          '  const atStop = count;',
          "  process.on('exit', () => {",
          '    process.stdout.write(JSON.stringify({ atStop, atExit: count, sawGc }) + "\\n");',
          '  });',
          '}, 200);',
          '',
        ].join('\n'),
      );

      const child = spawnSync(process.execPath, [join(outDir, 'child.mjs')], {
        cwd: outDir,
        encoding: 'utf8',
        timeout: 15_000,
      });

      expect(child.error, `child failed to run: ${String(child.error)}`).toBeUndefined();
      expect(
        child.signal,
        `child was killed (did not exit on its own):\n${child.stderr}`,
      ).toBeNull();
      expect(child.status, `child exited non-zero:\n${child.stderr}`).toBe(0);

      const lines = child.stdout.trim().split('\n');
      const last = lines[lines.length - 1] ?? '';
      const parsed = JSON.parse(last) as { atStop: number; atExit: number; sawGc: boolean };

      // The controller ran with its GC sampler: its samples carried a gc part.
      expect(parsed.atStop).toBeGreaterThanOrEqual(1);
      expect(parsed.sawGc, 'controller samples carry a gc part').toBe(true);
      // No sample is delivered after stop() returns.
      expect(parsed.atExit).toBe(parsed.atStop);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 150_000);
});
