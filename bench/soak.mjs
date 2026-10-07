#!/usr/bin/env node
// Soak test: the agent under sustained HTTP load with fast sampling, its NDJSON flowing into a
// collector process that serves the dashboard to churning SSE clients, floods OTLP exporters at a
// dead endpoint, and churns analyzer workers and plugin sandboxes. Node core only; run
// `npm run build` first.
//
//   node bench/soak.mjs [--duration 120] [--baseline 30] [--interval-ms 100] [--connections 8]
//                       [--sse-concurrency 10] [--stalled-clients 5] [--max-heap-growth 10]
//                       [--heap-ceiling 512] [--out soak.json]
//
// Exits 1 if heap-after-GC grows more than --max-heap-growth percent between the baseline and the
// end in either process, if any Worker thread or child process outlives its owner's close(), if
// dashboard clients are left behind, if a request fails, or if a process does not exit on its own.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { forkChild } from './lib/child.mjs';
import {
  cleanEnv,
  describe,
  gitCommit,
  parsePositive,
  resolveAgent,
  sleep,
} from './lib/common.mjs';
import { createLoad } from './lib/load.mjs';
import { startSseChurn } from './lib/sse-churn.mjs';
import { fmtNumber, fmtPct, table } from './lib/stats.mjs';

const APP = fileURLToPath(new URL('./lib/soak-app.mjs', import.meta.url));
const COLLECTOR = fileURLToPath(new URL('./lib/soak-collector.mjs', import.meta.url));
const READY_TIMEOUT_MS = 30_000;
const REPLY_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 15_000;
const PROGRESS_EVERY_MS = 15_000;
const PROBE_EVERY_MS = 5_000;
const SETTLE_MS = 1_000;
const MiB = 1024 * 1024;

const HELP = `Usage: node bench/soak.mjs [options]

  --duration <s>          total soak seconds (default 120)
  --baseline <s>          when the heap baseline is taken (default min(30, duration / 4))
  --interval-ms <n>       agent sampling interval, ARGUS_INTERVAL_MS (default 100)
  --connections <n>       keep-alive connections of HTTP load (default 8)
  --sse-concurrency <n>   SSE connect/read/disconnect loops (default 10)
  --stalled-clients <n>   SSE clients connected for the whole run that never read (default 5)
  --max-heap-growth <pct> heap-after-GC growth from baseline to end that fails (default 10)
  --heap-ceiling <MiB>    stop early and fail if either process's heap passes this (default 512)
  --out <file>            also write the result as JSON
  --help                  show this help
`;

function parseCli() {
  const { values } = parseArgs({
    options: {
      duration: { type: 'string', default: '120' },
      baseline: { type: 'string' },
      'interval-ms': { type: 'string', default: '100' },
      connections: { type: 'string', default: '8' },
      'sse-concurrency': { type: 'string', default: '10' },
      'stalled-clients': { type: 'string', default: '5' },
      'max-heap-growth': { type: 'string', default: '10' },
      'heap-ceiling': { type: 'string', default: '512' },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const durationMs = Math.round(parsePositive('duration', values.duration) * 1000);
  const baselineMs =
    values.baseline === undefined
      ? Math.min(30_000, Math.round(durationMs / 4))
      : Math.round(parsePositive('baseline', values.baseline) * 1000);
  if (baselineMs >= durationMs) throw new Error('--baseline must be earlier than --duration');
  return {
    durationMs,
    baselineMs,
    intervalMs: parsePositive('interval-ms', values['interval-ms'], { integer: true }),
    connections: parsePositive('connections', values.connections, { integer: true }),
    sseConcurrency: parsePositive('sse-concurrency', values['sse-concurrency'], { integer: true }),
    stalledClients: Number.parseInt(values['stalled-clients'], 10),
    maxHeapGrowth: parsePositive('max-heap-growth', values['max-heap-growth']) / 100,
    heapCeiling: parsePositive('heap-ceiling', values['heap-ceiling']) * MiB,
    out: values.out === undefined ? undefined : path.resolve(values.out),
  };
}

/** PIDs of the live children of `pid` (pgrep exits 1 when there are none). */
function childPids(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map(Number);
  } catch (err) {
    if (err !== null && typeof err === 'object' && err.status === 1) return [];
    throw err;
  }
}

function log(line) {
  process.stderr.write(`[soak] ${line}\n`);
}

async function heaps(app, collector) {
  const [a, c] = await Promise.all([
    app.request({ type: 'heap' }, 'heap', REPLY_TIMEOUT_MS),
    collector.request({ type: 'heap' }, 'heap', REPLY_TIMEOUT_MS),
  ]);
  return { app: a.heapUsed, collector: c.heapUsed, appRss: a.rss, collectorRss: c.rss };
}

async function main() {
  const opts = parseCli();
  if (Number.isNaN(opts.stalledClients) || opts.stalledClients < 0) {
    throw new Error('--stalled-clients must be a non-negative integer');
  }
  const { agentUrl } = resolveAgent();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'argus-soak-'));
  const startedAt = new Date().toISOString();
  log(
    `${opts.durationMs / 1000} s soak, heap baseline at ${opts.baselineMs / 1000} s, agent interval ` +
      `${opts.intervalMs} ms, node ${process.version}`,
  );

  const collector = forkChild(COLLECTOR, {
    execArgv: ['--expose-gc'],
    env: cleanEnv({}),
    cwd,
    stdin: 'pipe',
  });
  const app = forkChild(APP, {
    execArgv: ['--expose-gc', '--import', agentUrl],
    env: cleanEnv({ ARGUS_INTERVAL_MS: String(opts.intervalMs), ARGUS_OUTPUT: 'stdout' }),
    cwd,
    stdout: 'pipe',
  });
  const failures = [];
  const result = { checks: [], info: {} };
  let load;
  let churn;
  let piped;
  try {
    const [{ port }, { dashboardPort, windowMs }] = await Promise.all([
      app.request(null, 'ready', READY_TIMEOUT_MS),
      collector.request(null, 'ready', READY_TIMEOUT_MS),
    ]);
    piped = pipeline(app.child.stdout, collector.child.stdin).then(
      () => undefined,
      (err) => err,
    );

    load = createLoad({ port, connections: opts.connections, pathFor: (i) => `/soak/${i}` });
    churn = startSseChurn({
      port: dashboardPort,
      concurrency: opts.sseConcurrency,
      stalled: opts.stalledClients,
    });
    const started = Date.now();
    const elapsed = () => Date.now() - started;

    // Probe both processes every few seconds: progress for the log, and a ceiling that ends the
    // run early (as a failure) before a runaway leak takes the machine down with it.
    let base;
    let lastLog = 0;
    while (elapsed() < opts.durationMs) {
      const untilBaseline = base === undefined ? opts.baselineMs - elapsed() : Infinity;
      await sleep(
        Math.max(0, Math.min(PROBE_EVERY_MS, opts.durationMs - elapsed(), untilBaseline)),
      );
      if (base === undefined && elapsed() >= opts.baselineMs) {
        base = await heaps(app, collector);
        log(
          `baseline heap after GC: app ${fmtNumber(base.app / MiB, 2)} MiB, collector ` +
            `${fmtNumber(base.collector / MiB, 2)} MiB`,
        );
      }
      const [a, c] = await Promise.all([
        app.request({ type: 'stats' }, 'stats', REPLY_TIMEOUT_MS),
        collector.request({ type: 'stats' }, 'stats', REPLY_TIMEOUT_MS),
      ]);
      if (elapsed() - lastLog >= PROGRESS_EVERY_MS) {
        lastLog = elapsed();
        log(
          `${Math.round(elapsed() / 1000)} s: ${fmtNumber(a.handled)} requests, app heap ` +
            `${fmtNumber(a.heapUsed / MiB, 1)} MiB, collector heap ` +
            `${fmtNumber(c.heapUsed / MiB, 1)} MiB, ${c.windows} windows, ` +
            `${churn.stats().cycles} SSE cycles`,
        );
      }
      const over = [
        ['app', a.heapUsed],
        ['collector', c.heapUsed],
      ].filter(([, used]) => used > opts.heapCeiling);
      if (over.length > 0) {
        const [which, used] = over[0];
        failures.push(
          `${which} heap ${fmtNumber(used / MiB)} MiB passed the ${fmtNumber(opts.heapCeiling / MiB)} MiB ` +
            `ceiling at ${Math.round(elapsed() / 1000)} s; run stopped early`,
        );
        log(failures[failures.length - 1]);
        break;
      }
    }
    const end = await heaps(app, collector);
    const loadTotals = load.totals();
    await load.stop();
    load = undefined;
    const sse = await churn.stop();
    churn = undefined;
    log('load stopped; closing');

    await sleep(SETTLE_MS);
    const collectorStats = await collector.request({ type: 'stats' }, 'stats', REPLY_TIMEOUT_MS);
    const collectorClosed = await collector.request({ type: 'close' }, 'closed', REPLY_TIMEOUT_MS);
    const collectorChildren = childPids(collector.child.pid);
    const appClosed = await app.request({ type: 'close' }, 'closed', REPLY_TIMEOUT_MS);
    const appChildren = childPids(app.child.pid);

    await app.send({ type: 'exit' });
    const appExit = await app.waitExit(EXIT_TIMEOUT_MS);
    await collector.send({ type: 'exit' });
    const collectorExit = await collector.waitExit(EXIT_TIMEOUT_MS);
    const pipeError = await piped;

    const check = (name, ok, detail) => {
      result.checks.push({ name, ok, detail });
      if (!ok) failures.push(`${name}: ${detail}`);
    };
    const growth = (from, to) => (to - from) / from;
    for (const which of ['app', 'collector']) {
      if (base === undefined) {
        check(`${which} heap after GC`, false, 'run stopped before the baseline was taken');
        continue;
      }
      const g = growth(base[which], end[which]);
      check(
        `${which} heap after GC`,
        g <= opts.maxHeapGrowth,
        `${fmtNumber(base[which] / MiB, 2)} → ${fmtNumber(end[which] / MiB, 2)} MiB ` +
          `(${fmtPct(g)}, limit +${fmtPct(opts.maxHeapGrowth, { signed: false })})`,
      );
    }
    check(
      'app worker threads / child processes after close',
      appClosed.liveWorkers === 0 && appChildren.length === 0,
      `${appClosed.liveWorkers} workers, ${appChildren.length} children`,
    );
    check(
      'collector worker threads after close',
      collectorClosed.liveWorkers === 0,
      `${collectorClosed.liveWorkers} live of ${collectorClosed.createdWorkers} created`,
    );
    check(
      'collector child processes after close',
      collectorChildren.length === 0 && collectorClosed.childProcesses === 0,
      `${collectorChildren.length} (pgrep), ${collectorClosed.childProcesses} process handles`,
    );
    check(
      'dashboard SSE clients after churn',
      collectorClosed.clientCountBeforeClose === 0,
      `${collectorClosed.clientCountBeforeClose} connected after all clients hung up`,
    );
    check(
      'HTTP requests',
      loadTotals.errors === 0 && appClosed.errors === 0,
      `${loadTotals.errors} client errors, ${appClosed.errors} server errors` +
        `${loadTotals.firstError === undefined ? '' : ` (first: ${loadTotals.firstError})`}` +
        `${appClosed.firstError === undefined ? '' : ` (server: ${appClosed.firstError})`}`,
    );
    check(
      'SSE client errors',
      sse.errors === 0,
      `${sse.errors}${sse.firstError === undefined ? '' : ` (first: ${sse.firstError})`}`,
    );
    check(
      'app exits on its own after close',
      appExit !== undefined && appExit.code === 0,
      appExit === undefined
        ? `still running after ${EXIT_TIMEOUT_MS} ms (active: ${appClosed.activeResources.join(', ')})`
        : `code ${String(appExit.code)}, signal ${String(appExit.signal)}`,
    );
    check(
      'collector exits on its own after close',
      collectorExit !== undefined && collectorExit.code === 0,
      collectorExit === undefined
        ? `still running after ${EXIT_TIMEOUT_MS} ms (active: ${collectorClosed.activeResources.join(', ')})`
        : `code ${String(collectorExit.code)}, signal ${String(collectorExit.signal)}`,
    );
    check(
      'agent stayed enabled',
      !app.stderr().includes('[argus]'),
      app.stderr().trim() === '' ? 'no agent stderr' : app.stderr().trim(),
    );
    check(
      'NDJSON pipe app → collector',
      pipeError === undefined,
      pipeError === undefined ? 'clean end' : describe(pipeError),
    );

    const seconds = elapsed() / 1000;
    const expectedWindows = Math.floor((opts.durationMs / windowMs) * 0.9);
    result.info = {
      requests: loadTotals.requests,
      rps: Math.round(appClosed.handled / seconds),
      heapAfterGc: { baseline: base, end },
      sse,
      collector: collectorClosed.counters,
      windowsExpectedAtLeast: expectedWindows,
      exporters: collectorClosed.exporters,
      dashboard: {
        droppedEvents: collectorClosed.droppedEvents,
        errors: collectorClosed.counters.dashboardErrors,
      },
      errorSamples: collectorClosed.errorSamples,
      collectorStatsAtStop: collectorStats,
      appStderr: app.stderr(),
      collectorStderr: collector.stderr(),
    };
  } catch (err) {
    failures.push(`harness: ${describe(err)}`);
  } finally {
    if (load !== undefined) await load.stop().catch((err) => failures.push(describe(err)));
    if (churn !== undefined) await churn.stop().catch((err) => failures.push(describe(err)));
    await app.kill();
    await collector.kill();
    await rm(cwd, { recursive: true, force: true });
  }

  const info = result.info;
  const rows = result.checks.map((c) => [c.ok ? 'pass' : 'FAIL', c.name, c.detail]);
  process.stdout.write(
    `Argus soak — node ${process.version}, ${process.platform} ${process.arch}, ` +
      `${opts.durationMs / 1000} s, agent interval ${opts.intervalMs} ms\n\n` +
      table(['result', 'check', 'detail'], rows) +
      '\n',
  );
  if (info.requests !== undefined) {
    const c = info.collector;
    const ruleFailures = Object.entries(c.ruleFailed)
      .map(([code, n]) => `${code} ×${n}`)
      .join(', ');
    process.stdout.write(
      `\nLoad: ${fmtNumber(info.requests)} requests (${fmtNumber(info.rps)} rps), ` +
        `${opts.connections} connections\n` +
        `SSE: ${fmtNumber(info.sse.cycles)} connect/read/disconnect cycles, ${info.sse.stalled} ` +
        `clients stalled for the whole run, dashboard dropped ` +
        `${fmtNumber(info.dashboard.droppedEvents)} events, ${info.dashboard.errors} dashboard errors\n` +
        `Collector: ${fmtNumber(c.lines)} NDJSON lines, ${fmtNumber(c.spans)} spans, ` +
        `${fmtNumber(c.windows)} windows (informational: ≥ ${fmtNumber(info.windowsExpectedAtLeast)} ` +
        'expected if every sample arrived)\n' +
        `OTLP flood: metrics ${fmtNumber(info.exporters.metrics.dropped)} dropped / ` +
        `${fmtNumber(info.exporters.metrics.failed)} failed, traces ` +
        `${fmtNumber(info.exporters.traces.dropped)} dropped / ${fmtNumber(info.exporters.traces.failed)} failed\n` +
        `Analyzer: ${c.symbolizeOk} symbolizations ok, ${c.symbolizeFailed} failed; ` +
        `plugin rules: ${c.ruleOk} ok${ruleFailures === '' ? '' : `, ${ruleFailures}`}\n`,
    );
    if (Object.keys(info.errorSamples).length > 0) {
      process.stdout.write(`First errors seen: ${JSON.stringify(info.errorSamples)}\n`);
    }
  }
  if (opts.out !== undefined) {
    // Exclusive create, owner-only: never follow or overwrite an existing file or symlink.
    await mkdir(path.dirname(opts.out), { recursive: true });
    await writeFile(
      opts.out,
      `${JSON.stringify(
        {
          schema: 1,
          tool: 'argus bench/soak.mjs',
          startedAt,
          finishedAt: new Date().toISOString(),
          commit: gitCommit(),
          node: process.version,
          platform: `${process.platform} ${os.release()} ${process.arch}`,
          settings: opts,
          ok: failures.length === 0,
          failures,
          ...result,
        },
        null,
        2,
      )}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    process.stdout.write(`\nJSON: ${opts.out}\n`);
  }
  if (failures.length > 0) {
    process.stdout.write(`\nSOAK FAILED\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nSOAK PASSED\n');
  }
}

main().catch((err) => {
  process.stderr.write(`[soak] ${describe(err)}\n`);
  process.exitCode = 1;
});
