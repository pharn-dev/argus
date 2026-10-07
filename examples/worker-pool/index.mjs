import 'argus/agent';
import { takeHeapSnapshot } from 'argus/agent';
import { createHeapSnapshotPool, summarizeHeapSnapshot } from 'argus/analyzer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const CPU_TASKS = 4;
const PRIME_LIMIT = 200_000;
const TOP_ENTRIES = 5;
const PREFIX = '[worker-pool] ';

function log(line) {
  process.stdout.write(`${PREFIX}${line}\n`);
}

function describe(err) {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

// Run `work`, then always run `cleanup`. A cleanup failure is never ignored: it is
// thrown when `work` succeeded, and reported on stderr alongside the primary error otherwise.
async function withCleanup(work, label, cleanup) {
  let primaryError;
  let failed = false;
  try {
    await work();
  } catch (err) {
    primaryError = err;
    failed = true;
  }
  try {
    await cleanup();
  } catch (cleanupErr) {
    if (!failed) throw cleanupErr;
    process.stderr.write(`${PREFIX}cleanup failed (${label}): ${describe(cleanupErr)}\n`);
  }
  if (failed) throw primaryError;
}

// Run one CPU task on its own Worker Thread. Resolves only on a well-formed
// numeric result; rejects on error, messageerror, or an exit without a result.
function runCpuTask(limit) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./workers/cpu-task.worker.mjs', import.meta.url), {
      workerData: { limit },
    });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    worker.once('message', (message) => {
      if (
        message !== null &&
        typeof message === 'object' &&
        Number.isSafeInteger(message.primes) &&
        message.primes >= 0
      ) {
        settle(resolve, message.primes);
      } else {
        settle(reject, new Error('cpu task worker sent a malformed result'));
      }
    });
    worker.once('error', (err) => settle(reject, err));
    worker.once('messageerror', (err) => settle(reject, err));
    worker.once('exit', (code) => {
      settle(
        reject,
        new Error(
          code === 0
            ? 'cpu task worker exited before sending a result'
            : `cpu task worker exited with code ${code}`,
        ),
      );
    });
  });
}

async function runCpuTasks() {
  const results = await Promise.allSettled(
    Array.from({ length: CPU_TASKS }, () => runCpuTask(PRIME_LIMIT)),
  );
  const fulfilled = results.filter((result) => result.status === 'fulfilled').length;
  log(`cpu tasks completed: ${fulfilled}`);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
}

async function analyzeHeap(dir) {
  const snapshot = await takeHeapSnapshot({ dir });
  const pool = createHeapSnapshotPool({ size: 1 });
  await withCleanup(
    async () => {
      // Count main-thread ticks only while the analysis runs on the analyzer worker.
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 1);
      let summary;
      try {
        summary = await summarizeHeapSnapshot(snapshot.path, { pool, top: TOP_ENTRIES });
      } finally {
        clearInterval(timer);
      }
      log(`heap snapshot: nodes=${summary.nodeCount} totalSelfSize=${summary.totalSelfSize}`);
      if (summary.top.length === 0) {
        throw new Error('heap snapshot summary has no top entries');
      }
      for (const entry of summary.top) {
        log(`heap top: ${entry.name} count=${entry.count} selfSize=${entry.selfSize}`);
      }
      log(`event loop ticks during analysis: ${ticks}`);
    },
    'pool.close',
    () => pool.close(),
  );
}

async function main() {
  await runCpuTasks();

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'argus-worker-pool-example-'));
  await withCleanup(
    async () => {
      await analyzeHeap(dir);
      log('done');
    },
    `rm ${dir}`,
    () => fs.promises.rm(dir, { recursive: true, force: true }),
  );
}

main().catch((err) => {
  process.stderr.write(`${PREFIX}failed: ${describe(err)}\n`);
  process.exitCode = 1;
});
