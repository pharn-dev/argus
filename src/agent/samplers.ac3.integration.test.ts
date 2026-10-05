import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentSample } from './index.js';

const agentDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(agentDir, '..', '..');

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('agent samplers — AC-3', () => {
  it('AC-3: start twice then stop gives at most one sample per interval and none after stop', async () => {
    const { createSamplerController } = await import('./index.js');

    const intervalMs = 100;
    const samples: AgentSample[] = [];
    const controller = createSamplerController((sample: AgentSample) => {
      samples.push(sample);
    });

    const startedAt = Date.now();
    controller.start(intervalMs);
    controller.start(intervalMs);
    await delay(650);
    controller.stop();
    const elapsed = Date.now() - startedAt;
    const countAtStop = samples.length;

    // Samples did arrive while running ...
    expect(countAtStop).toBeGreaterThanOrEqual(1);
    // ... but at most once per interval (a second timer would roughly double this).
    expect(countAtStop).toBeLessThanOrEqual(Math.floor(elapsed / intervalMs) + 1);

    // No sample arrives after stop() returns.
    await delay(400);
    expect(samples.length).toBe(countAtStop);
  }, 10_000);

  it('AC-3: a separate Node process that only starts the controller exits on its own with code 0', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'argus-ac3-'));
    try {
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
      writeFileSync(
        join(outDir, 'child.mjs'),
        [
          "import { createSamplerController } from './index.js';",
          'const controller = createSamplerController(() => {});',
          'controller.start(50);',
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
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 150_000);
});
