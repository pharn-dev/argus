// F-07 (result caps) and F-19 (sandbox child flags) for the plugin runner.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AggregatedWindow } from '../collector/index.js';
import { createPluginRunner, RuleErrorCode, type RuleRunResult } from './index.js';
import { createSandboxProcess, sandboxExecArgv } from './sandbox-process.js';

const srcDir = fileURLToPath(new URL('.', import.meta.url));

const WINDOW: AggregatedWindow = {
  start: 1_000,
  end: 2_000,
  count: 10,
  late: 0,
  eventLoop: { max: 50, p99: 50, mean: 10 },
  memory: { heapUsedLast: 1000, heapUsedMax: 2000, rssLast: 3000, rssMax: 4000 },
  gc: { count: 1, totalPause: 5, maxPause: 5 },
  backpressure: { events: 0, totalStall: 0, maxStall: 0 },
};

function findingsRule(count: number, message = ''): string {
  return `const out = []; for (let i = 0; i < ${String(count)}; i += 1) out.push({ windowStart: i, message: ${JSON.stringify(message)} }); return out;`;
}

function failureOf(result: RuleRunResult): { code: string; message: string } {
  if (result.ok)
    throw new Error(`expected a failure, got ${String(result.findings.length)} findings`);
  return result.error;
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'argus-plugin-caps-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('plugin rule result caps (F-07)', () => {
  it('rejects a rule returning 1M findings with ARGUS_RULE_INVALID_RESULT and bounded host memory', async () => {
    const runner = createPluginRunner({ memoryLimitMb: 256, timeoutMs: 20_000 });
    try {
      // Warm the sandbox so the child's own start-up is not counted.
      expect(await runner.run('return [];', [WINDOW])).toEqual({ ok: true, findings: [] });
      const before = process.memoryUsage().rss;
      const result = await runner.run(findingsRule(1_000_000), [WINDOW]);
      const grownMiB = (process.memoryUsage().rss - before) / (1024 * 1024);
      const error = failureOf(result);
      expect(error.code).toBe(RuleErrorCode.INVALID_RESULT);
      expect(error.message).toContain('maxResultBytes');
      // Before the cap, the findings crossed IPC and grew the host by several hundred MiB.
      expect(grownMiB).toBeLessThan(64);
    } finally {
      await runner.close();
    }
  }, 60_000);

  it('enforces configurable maxFindings and maxResultBytes', async () => {
    const runner = createPluginRunner({ maxFindings: 3, maxResultBytes: 200 });
    try {
      const three = await runner.run(findingsRule(3), [WINDOW]);
      expect(three.ok).toBe(true);
      const four = failureOf(await runner.run(findingsRule(4), [WINDOW]));
      expect(four.code).toBe(RuleErrorCode.INVALID_RESULT);
      expect(four.message).toContain('maxFindings');
      const big = failureOf(await runner.run(findingsRule(2, 'x'.repeat(300)), [WINDOW]));
      expect(big.code).toBe(RuleErrorCode.INVALID_RESULT);
      expect(big.message).toContain('maxResultBytes');
      const thrown = failureOf(await runner.run(`throw new Error('y'.repeat(1e6));`, [WINDOW]));
      expect(thrown.code).toBe(RuleErrorCode.RULE_THREW);
      expect(thrown.message.length).toBeLessThan(5000);
    } finally {
      await runner.close();
    }
    expect(() => createPluginRunner({ maxFindings: 0 })).toThrow(RangeError);
    expect(() => createPluginRunner({ maxResultBytes: 1.5 })).toThrow(RangeError);
  }, 30_000);

  it('re-validates the shape and size of the reply on the host', async () => {
    const script = join(dir, 'bad-child.mjs');
    await writeFile(
      script,
      `process.on('message', (m) => {
  const results = {
    'not-findings': { ok: true, findings: 'nope' },
    'bad-finding': { ok: true, findings: [{ windowStart: 1.5, message: 'x' }] },
    'too-many': { ok: true, findings: [1, 2, 3].map((i) => ({ windowStart: i, message: 'm' })) },
    'unknown-code': { ok: false, error: { code: 'NOPE', message: 'x' } },
    'good': { ok: true, findings: [{ windowStart: 1, message: 'm' }] },
  };
  process.send({ type: 'result', id: m.id, result: results[m.source] });
});
process.on('disconnect', () => process.exit(0));
`,
    );
    const sandbox = createSandboxProcess(script, { maxFindings: 2, maxResultBytes: 100 });
    const ask = (source: string): Promise<RuleRunResult> =>
      sandbox.request(
        {
          source,
          windowsJson: '[]',
          timeoutMs: 1000,
          memoryLimitMb: 64,
          isolatedVmModule: 'isolated-vm',
          maxFindings: 2,
          maxResultBytes: 100,
        },
        10_000,
      );
    try {
      for (const source of ['not-findings', 'bad-finding', 'too-many', 'unknown-code']) {
        const error = failureOf(await ask(source));
        expect(error.code, source).toBe(RuleErrorCode.INVALID_RESULT);
      }
      expect(await ask('good')).toEqual({ ok: true, findings: [{ windowStart: 1, message: 'm' }] });
    } finally {
      await sandbox.kill();
    }
  }, 30_000);
});

describe('sandbox child flags (F-19)', () => {
  it('keeps --no-node-snapshot and forwards the host Permission Model flags only', () => {
    expect(sandboxExecArgv([])).toEqual(['--no-node-snapshot']);
    expect(
      sandboxExecArgv([
        '--input-type=module',
        '-e',
        'code',
        '--permission',
        '--allow-fs-read=/srv',
        '--allow-fs-read',
        '/opt/app',
        '--max-old-space-size=100',
        '--allow-addons',
        '--inspect=9229',
      ]),
    ).toEqual([
      '--no-node-snapshot',
      '--permission',
      '--allow-fs-read=/srv',
      '--allow-fs-read',
      '/opt/app',
      '--allow-addons',
    ]);
    expect(sandboxExecArgv(['--experimental-permission', '--allow-worker'])).toEqual([
      '--no-node-snapshot',
      '--experimental-permission',
      '--allow-worker',
    ]);
  });

  it('starts the sandbox child under --permission when the host has it', async () => {
    const script = join(dir, 'probe-child.mjs');
    await writeFile(
      script,
      `process.on('message', (m) => {
  const message = JSON.stringify({
    execArgv: process.execArgv,
    canWrite: process.permission ? process.permission.has('fs.write') : null,
  });
  process.send({ type: 'result', id: m.id, result: { ok: true, findings: [{ windowStart: 0, message }] } });
});
process.on('disconnect', () => process.exit(0));
`,
    );
    const sandbox = createSandboxProcess(script, {
      maxFindings: 10,
      maxResultBytes: 10_000,
      hostExecArgv: ['--input-type=module', '--permission', '--allow-fs-read=*'],
    });
    try {
      const result = await sandbox.request(
        {
          source: '',
          windowsJson: '[]',
          timeoutMs: 1000,
          memoryLimitMb: 64,
          isolatedVmModule: 'isolated-vm',
          maxFindings: 10,
          maxResultBytes: 10_000,
        },
        10_000,
      );
      if (!result.ok) throw new Error(result.error.message);
      const probe = JSON.parse(result.findings[0]?.message ?? '{}') as {
        execArgv: string[];
        canWrite: boolean | null;
      };
      expect(probe.execArgv).toEqual(['--no-node-snapshot', '--permission', '--allow-fs-read=*']);
      expect(probe.canWrite).toBe(false);
    } finally {
      await sandbox.kill();
    }
  }, 20_000);

  it('a host under --permission without --allow-addons cannot give the sandbox isolated-vm', () => {
    const hooks = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return next(specifier.slice(0, -3) + '.ts', context);
      }
      throw error;
    }
  },
});`)}`;
    const script = `
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { createPluginRunner } = await import(pathToFileURL(join(process.argv[1], 'plugin-runner.ts')).href);
const runner = createPluginRunner();
const result = await runner.run('return [{ windowStart: 1, message: "hi" }];', []);
await runner.close();
console.log(JSON.stringify(result));
`;
    const run = (extra: string[]): unknown => {
      const child = spawnSync(
        process.execPath,
        [
          '--permission',
          '--allow-fs-read=*',
          '--allow-child-process',
          ...extra,
          '--import',
          hooks,
          '--input-type=module',
          '-e',
          script,
          srcDir,
        ],
        { cwd: srcDir, encoding: 'utf8', timeout: 60_000 },
      );
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
      return JSON.parse(child.stdout.trim().split('\n').pop() ?? '');
    };
    // Without the grant, the sandbox child is as constrained as the host: no native addon.
    expect(run([])).toMatchObject({
      ok: false,
      error: { code: RuleErrorCode.ISOLATED_VM_MISSING },
    });
    // With it, the rule runs.
    expect(run(['--allow-addons'])).toEqual({
      ok: true,
      findings: [{ windowStart: 1, message: 'hi' }],
    });
  }, 130_000);
});
