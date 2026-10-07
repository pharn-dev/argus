// Containment of analyzer workers: input caps, heap limits, worker OOM and host execArgv.
// Anything that could kill the process (a V8 fatal OOM aborts the whole process, not just the
// worker) runs in a child Node process, so a regression fails the test instead of the runner.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorkerPool,
  DEFAULT_RESOURCE_LIMITS,
  HeapSnapshotTooLargeError,
  diffHeapSnapshots,
  summarizeHeapSnapshot,
  type WorkerPool,
} from './index.js';
import { portableExecArgv, workerExecArgv } from './worker-exec-argv.js';

const srcDir = fileURLToPath(new URL('.', import.meta.url));
const testWorker = join(srcDir, 'workers', 'test-task.worker.ts');

// Lets a plain `node` child import this module's TypeScript sources (`./x.js` -> `./x.ts`).
const TS_HOOKS = `
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
});
`;
const TS_HOOKS_URL = `data:text/javascript,${encodeURIComponent(TS_HOOKS)}`;

const SMALL_SNAPSHOT = JSON.stringify({
  snapshot: { meta: { node_fields: ['type', 'name', 'self_size'], node_types: [['object']] } },
  nodes: [0, 0, 10, 0, 1, 20],
  strings: ['Alpha', 'Beta'],
});

type ChildResult = { status: number | null; signal: string | null; output: string; last: unknown };

function runNode(args: string[], timeoutMs: number): ChildResult {
  const child = spawnSync(process.execPath, args, {
    cwd: srcDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const lines = child.stdout.trim().split('\n');
  let last: unknown;
  try {
    last = JSON.parse(lines[lines.length - 1] ?? '');
  } catch {
    last = undefined;
  }
  return {
    status: child.status,
    signal: child.signal,
    output: `${child.stdout}\n${child.stderr}`.slice(-4000),
    last,
  };
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'argus-containment-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('heap-snapshot input cap (F-02)', () => {
  function spyPool(): WorkerPool & { calls: number } {
    const pool = {
      size: 1,
      closed: false,
      calls: 0,
      run<T>(): Promise<T> {
        pool.calls += 1;
        return Promise.reject(new Error('the pool must not be used'));
      },
      close: () => Promise.resolve(),
    };
    return pool;
  }

  it('rejects a snapshot above maxSnapshotBytes with a typed error before dispatching it', async () => {
    const path = join(dir, 'over-cap.heapsnapshot');
    await writeFile(path, SMALL_SNAPSHOT);
    const pool = spyPool();
    const error: unknown = await summarizeHeapSnapshot(path, { pool, maxSnapshotBytes: 16 }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(HeapSnapshotTooLargeError);
    expect(error).toMatchObject({
      code: 'ERR_HEAP_SNAPSHOT_TOO_LARGE',
      path,
      size: SMALL_SNAPSHOT.length,
      maxBytes: 16,
    });
    await expect(
      diffHeapSnapshots(path, path, { pool, maxSnapshotBytes: 16 }),
    ).rejects.toBeInstanceOf(HeapSnapshotTooLargeError);
    expect(pool.calls).toBe(0);
  });

  it('accepts a snapshot under the cap and validates maxSnapshotBytes', async () => {
    const path = join(dir, 'under-cap.heapsnapshot');
    await writeFile(path, SMALL_SNAPSHOT);
    const summary = await summarizeHeapSnapshot(path, { maxSnapshotBytes: SMALL_SNAPSHOT.length });
    expect(summary).toEqual({
      nodeCount: 2,
      totalSelfSize: 30,
      top: [
        { name: 'Beta', count: 1, selfSize: 20 },
        { name: 'Alpha', count: 1, selfSize: 10 },
      ],
    });
    await expect(summarizeHeapSnapshot(path, { maxSnapshotBytes: 0 })).rejects.toThrow(RangeError);
  });

  it('keeps the host alive when a snapshot under the cap meets small worker heap limits', async () => {
    // On the unfixed analyzer, a 25 MiB snapshot parsed with JSON.parse under these limits made V8
    // abort the host (SIGABRT, "Reached heap limit") instead of terminating the worker.
    const script = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [srcDir, dir] = process.argv.slice(2);
const { createHeapSnapshotPool, summarizeHeapSnapshot } = await import(
  pathToFileURL(join(srcDir, 'heap-snapshot.ts')).href
);
const big = join(dir, 'big.heapsnapshot');
const small = join(dir, 'small.heapsnapshot');
const parts = [];
for (let i = 0; i < 3_000_000; i += 1) parts.push(\`0,\${i % 1000},\${(i % 97) + 1}\`);
const strings = JSON.stringify(Array.from({ length: 1000 }, (_, i) => 's' + i));
writeFileSync(
  big,
  '{"snapshot":{"meta":{"node_fields":["type","name","self_size"],"node_types":[["object"]]}},' +
    '"nodes":[' + parts.join(',') + '],"strings":' + strings + '}',
);
writeFileSync(small, ${JSON.stringify(SMALL_SNAPSHOT)});
const results = [];
for (const [old, young] of [[40, 16], [48, 16], [64, 4], [32, 8]]) {
  const pool = createHeapSnapshotPool({
    resourceLimits: { maxOldGenerationSizeMb: old, maxYoungGenerationSizeMb: young },
  });
  let outcome;
  try {
    const summary = await summarizeHeapSnapshot(big, { pool, timeoutMs: 120_000 });
    outcome = summary.nodeCount === 3_000_000 ? 'ok' : 'wrong count';
  } catch (error) {
    outcome = error.code ?? error.message;
  }
  let after;
  try {
    after = (await summarizeHeapSnapshot(small, { pool })).nodeCount;
  } catch (error) {
    after = error.code ?? error.message;
  }
  await pool.close();
  results.push({ limits: [old, young], outcome, after });
}
console.log(JSON.stringify({ results, exitCode: process.exitCode ?? null }));
`;
    const scriptPath = join(dir, 'snapshot-host.mjs');
    await writeFile(scriptPath, script);
    const child = runNode(['--import', TS_HOOKS_URL, scriptPath, srcDir, dir], 170_000);
    expect(child.signal, child.output).toBeNull();
    expect(child.status, child.output).toBe(0);
    const report = child.last as {
      results: { limits: number[]; outcome: string; after: unknown }[];
      exitCode: unknown;
    };
    expect(report.exitCode).toBeNull();
    expect(report.results).toHaveLength(4);
    for (const result of report.results) {
      expect(['ok', 'ERR_WORKER_CRASHED'], JSON.stringify(result)).toContain(result.outcome);
      // The pool replaced any worker it lost and keeps serving.
      expect(result.after, JSON.stringify(result)).toBe(2);
    }
  }, 180_000);
});

describe('worker heap limits (F-02)', () => {
  it('runs every worker with the default resourceLimits when none are given', async () => {
    const pool = createWorkerPool({ size: 1, workerFile: testWorker });
    try {
      expect(pool.resourceLimits).toEqual(DEFAULT_RESOURCE_LIMITS);
      const limits = await pool.run<Record<string, number>>({ kind: 'limits' });
      expect(limits.maxOldGenerationSizeMb).toBe(DEFAULT_RESOURCE_LIMITS.maxOldGenerationSizeMb);
      expect(limits.maxYoungGenerationSizeMb).toBe(
        DEFAULT_RESOURCE_LIMITS.maxYoungGenerationSizeMb,
      );
    } finally {
      await pool.close();
    }
  });

  it('merges partial limits over the defaults and rejects invalid ones', async () => {
    const pool = createWorkerPool({
      size: 1,
      workerFile: testWorker,
      resourceLimits: { maxOldGenerationSizeMb: 96 },
    });
    try {
      expect(pool.resourceLimits).toEqual({
        maxOldGenerationSizeMb: 96,
        maxYoungGenerationSizeMb: DEFAULT_RESOURCE_LIMITS.maxYoungGenerationSizeMb,
      });
      const limits = await pool.run<Record<string, number>>({ kind: 'limits' });
      expect(limits.maxOldGenerationSizeMb).toBe(96);
    } finally {
      await pool.close();
    }
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createWorkerPool({
          size: 1,
          workerFile: testWorker,
          resourceLimits: { maxYoungGenerationSizeMb: bad },
        }),
      ).toThrow(RangeError);
    }
  });

  it('rejects the job of a worker that runs out of heap and keeps serving (host survives)', async () => {
    const script = `
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [srcDir] = process.argv.slice(2);
const { createWorkerPool } = await import(pathToFileURL(join(srcDir, 'worker-pool.ts')).href);
const pool = createWorkerPool({
  size: 1,
  workerFile: join(srcDir, 'workers', 'test-task.worker.ts'),
  resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
});
const outcomes = [];
for (let run = 0; run < 2; run += 1) {
  try {
    await pool.run({ kind: 'oom' }, { timeoutMs: 60_000 });
    outcomes.push('resolved');
  } catch (error) {
    outcomes.push(error.code + ': ' + error.message);
  }
  outcomes.push(JSON.stringify(await pool.run({ kind: 'echo', run })));
}
await pool.close();
console.log(JSON.stringify({ outcomes, exitCode: process.exitCode ?? null }));
`;
    const scriptPath = join(dir, 'oom-host.mjs');
    await writeFile(scriptPath, script);
    const child = runNode(['--import', TS_HOOKS_URL, scriptPath, srcDir], 120_000);
    expect(child.signal, child.output).toBeNull();
    expect(child.status, child.output).toBe(0);
    const report = child.last as { outcomes: string[]; exitCode: unknown };
    expect(report.exitCode).toBeNull();
    expect(report.outcomes).toHaveLength(4);
    expect(report.outcomes[0]).toMatch(/^ERR_WORKER_CRASHED: .*memory limit/);
    expect(report.outcomes[1]).toBe(JSON.stringify({ kind: 'echo', run: 0 }));
    expect(report.outcomes[2]).toMatch(/^ERR_WORKER_CRASHED: .*memory limit/);
    expect(report.outcomes[3]).toBe(JSON.stringify({ kind: 'echo', run: 1 }));
  }, 130_000);
});

describe('worker execArgv (F-19)', () => {
  it('drops the host entry-point flags and keeps the rest', () => {
    expect(workerExecArgv(['--enable-source-maps', '--import', 'tsx'])).toBeUndefined();
    expect(workerExecArgv([])).toBeUndefined();
    expect(workerExecArgv(['--input-type=module', '-e', 'console.log(-1)'])).toEqual([]);
    expect(
      workerExecArgv(['--inspect=9229', '--import', 'tsx', '-r', './setup.js', '-p', '-1']),
    ).toEqual(['--import', 'tsx', '-r', './setup.js']);
    expect(
      workerExecArgv(['--eval=1', '--input-type', 'module', '--conditions', 'dev', '--test']),
    ).toEqual(['--conditions', 'dev']);
    expect(
      portableExecArgv([
        '--expose-gc',
        '--max-old-space-size=100',
        '--import',
        'tsx',
        '--title',
        'app',
        '--allow-fs-read=/srv',
        '--permission',
      ]),
    ).toEqual(['--import', 'tsx', '--allow-fs-read=/srv', '--permission']);
  });

  const script = `
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const srcDir = process.argv[1];
const { createWorkerPool } = await import(pathToFileURL(join(srcDir, 'worker-pool.ts')).href);
const pool = createWorkerPool({ size: 1, workerFile: join(srcDir, 'workers', 'test-task.worker.ts') });
try {
  const value = await pool.run({ kind: 'echo', marker: 7 });
  console.log(JSON.stringify({ ok: true, value }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));
} finally {
  await pool.close();
}
`;

  it.each([
    ['--input-type=module -e', [] as string[]],
    ['--expose-gc --input-type=module -e', ['--expose-gc']],
  ])(
    'starts a worker when the host runs with %s',
    (_label, extra) => {
      const child = runNode(
        [...extra, '--import', TS_HOOKS_URL, '--input-type=module', '-e', script, srcDir],
        60_000,
      );
      expect(child.status, child.output).toBe(0);
      expect(child.last, child.output).toEqual({ ok: true, value: { kind: 'echo', marker: 7 } });
    },
    70_000,
  );
});
