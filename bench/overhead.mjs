#!/usr/bin/env node
// Agent-on versus agent-off HTTP benchmark. Node core only; run `npm run build` first.
//
//   node bench/overhead.mjs [--duration 5] [--warmup 1.5] [--connections 32] [--rounds 3]
//                           [--workloads trivial,promise,cpu,stream]
//                           [--variants none,idle,full,tracing,samplers]
//                           [--out results.json] [--node-arg=--some-flag ...]
//
// Every cell (workload x variant x round) gets a fresh target process; variants are interleaved
// within each round and the order rotates between rounds. See bench/README.md.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { forkChild } from './lib/child.mjs';
import {
  cleanEnv,
  describe,
  gitCommit,
  parseList,
  parsePositive,
  resolveAgent,
  sleep,
} from './lib/common.mjs';
import { createLoad } from './lib/load.mjs';
import { delta, fmtNumber, fmtPct, spread, table, withDelta } from './lib/stats.mjs';
import { WORKLOADS } from './lib/workloads.mjs';

const TARGET = fileURLToPath(new URL('./lib/bench-target.mjs', import.meta.url));
const VARIANTS = ['none', 'idle', 'full', 'tracing', 'samplers'];
const PATHS = 50;
const READY_TIMEOUT_MS = 20_000;
const REPLY_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 5_000;

const HELP = `Usage: node bench/overhead.mjs [options]

  --duration <s>       measured seconds per cell (default 5)
  --warmup <s>         warm-up seconds per cell before measuring (default 1.5)
  --connections <n>    concurrent keep-alive connections (default 32)
  --rounds <n>         interleaved rounds; medians are taken across rounds (default 3)
  --workloads <list>   comma list of ${WORKLOADS.join(', ')} (default all)
  --variants <list>    comma list of ${VARIANTS.join(', ')} (default all)
  --out <file>         write the JSON result here (default: a file in the OS temp dir)
  --node-arg <flag>    extra Node flag for every target, repeatable
                       (e.g. --node-arg=--experimental-async-context-frame on Node 22)
  --help               show this help
`;

function parseCli() {
  const { values } = parseArgs({
    options: {
      duration: { type: 'string', default: '5' },
      warmup: { type: 'string', default: '1.5' },
      connections: { type: 'string', default: '32' },
      rounds: { type: 'string', default: '3' },
      workloads: { type: 'string', default: WORKLOADS.join(',') },
      variants: { type: 'string', default: VARIANTS.join(',') },
      out: { type: 'string' },
      'node-arg': { type: 'string', multiple: true, default: [] },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  return {
    durationMs: Math.round(parsePositive('duration', values.duration) * 1000),
    warmupMs: Math.round(parsePositive('warmup', values.warmup) * 1000),
    connections: parsePositive('connections', values.connections, { integer: true }),
    rounds: parsePositive('rounds', values.rounds, { integer: true }),
    workloads: parseList('workloads', values.workloads, WORKLOADS),
    variants: parseList('variants', values.variants, VARIANTS),
    out:
      values.out === undefined
        ? path.join(
            os.tmpdir(),
            `argus-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
          )
        : path.resolve(values.out),
    nodeArgs: values['node-arg'],
  };
}

function variantSpec(variant, { agentUrl, indexUrl }) {
  switch (variant) {
    case 'none':
      return { execArgv: [], env: {} };
    case 'idle':
      // Loaded, then switched off by config: the cost of having the agent installed but disabled.
      return { execArgv: ['--import', agentUrl], env: { ARGUS_ENABLED: 'false' } };
    case 'full':
      // The agent's defaults: tracing plus every sampler, NDJSON to stdout (here /dev/null).
      return { execArgv: ['--import', agentUrl], env: {} };
    case 'tracing':
    case 'samplers':
      return { execArgv: [], env: { BENCH_AGENT_INDEX: indexUrl } };
    default:
      throw new Error(`unknown variant ${variant}`);
  }
}

async function runCell(opts, agent, workload, variant, round) {
  const spec = variantSpec(variant, agent);
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'argus-bench-'));
  const target = forkChild(TARGET, {
    execArgv: [...opts.nodeArgs, ...spec.execArgv],
    env: cleanEnv({ ...spec.env, BENCH_WORKLOAD: workload, BENCH_VARIANT: variant }),
    cwd,
  });
  const cell = { round, workload, variant, ok: false };
  let load;
  try {
    const { port } = await target.request(null, 'ready', READY_TIMEOUT_MS);
    load = createLoad({
      port,
      connections: opts.connections,
      pathFor: (i) => `/items/${i % PATHS}`,
    });
    await sleep(opts.warmupMs);
    await target.request({ type: 'start' }, 'started', REPLY_TIMEOUT_MS);
    load.startMeasure();
    await sleep(opts.durationMs);
    const client = load.endMeasure();
    const server = await target.request({ type: 'stop' }, 'stats', REPLY_TIMEOUT_MS);
    const totals = load.totals();
    await load.stop();
    load = undefined;
    delete server.type;
    cell.client = client;
    cell.server = server;
    const problems = [];
    if (totals.errors > 0) {
      problems.push(`${totals.errors} client errors (first: ${totals.firstError})`);
    }
    if (server.errors > 0) {
      problems.push(`${server.errors} server errors (first: ${server.firstError})`);
    }
    if (client.requests === 0) problems.push('no request completed in the measured window');
    if (target.stderr().includes('[argus]')) {
      problems.push(`agent reported on stderr: ${target.stderr().trim()}`);
    }
    if (problems.length > 0) throw new Error(problems.join('; '));
    cell.ok = true;
  } catch (err) {
    cell.error = describe(err);
  } finally {
    if (load !== undefined) {
      await load.stop().catch((err) => {
        cell.ok = false;
        cell.error = `${cell.error ?? ''}; load.stop failed: ${describe(err)}`;
      });
    }
    if (target.stderr().trim() !== '') cell.stderr = target.stderr().trim();
    // A target that already died has no channel; kill() below covers a target that will not exit.
    if (target.child.connected) {
      await target.send({ type: 'exit' }).catch((err) => {
        cell.ok = false;
        cell.error = `${cell.error ?? ''}; exit request failed: ${describe(err)}`;
      });
    }
    if ((await target.waitExit(EXIT_TIMEOUT_MS)) === undefined) await target.kill();
    await rm(cwd, { recursive: true, force: true });
  }
  return cell;
}

function metricsOf(cell) {
  const { client, server } = cell;
  const cpuUs = server.cpuUserUs + server.cpuSystemUs;
  return {
    rps: client.rps,
    p50Us: client.p50Us,
    p99Us: client.p99Us,
    cpuUsPerReq: server.requests === 0 ? NaN : cpuUs / server.requests,
    cpuPct: (cpuUs / server.wallUs) * 100,
    elu: server.elu,
    rssMiB: server.rssBytes / (1024 * 1024),
    gcCount: server.gcCount,
    gcPauseMs: server.gcPauseUs / 1000,
  };
}

const DELTA_METRICS = ['rps', 'p50Us', 'p99Us', 'cpuUsPerReq', 'cpuPct', 'rssMiB'];

function summarize(cells, opts) {
  const summary = {};
  for (const workload of opts.workloads) {
    summary[workload] = {};
    for (const variant of opts.variants) {
      const ok = cells.filter((c) => c.ok && c.workload === workload && c.variant === variant);
      if (ok.length === 0) continue;
      const metrics = ok.map(metricsOf);
      const entry = {};
      for (const key of Object.keys(metrics[0])) entry[key] = spread(metrics.map((m) => m[key]));
      summary[workload][variant] = entry;
    }
    const base = summary[workload].none;
    for (const entry of Object.values(summary[workload])) {
      entry.deltaVsNone = {};
      for (const key of DELTA_METRICS) {
        entry.deltaVsNone[key] = delta(entry[key].median, base?.[key].median) ?? null;
      }
    }
  }
  return summary;
}

function render(summary, opts) {
  const out = [];
  for (const workload of opts.workloads) {
    const rows = [];
    for (const variant of opts.variants) {
      const e = summary[workload][variant];
      if (e === undefined) {
        rows.push([variant, 'FAILED', '', '', '', '', '', '', '', '']);
        continue;
      }
      const d = variant === 'none' ? {} : e.deltaVsNone;
      const cvText = opts.rounds > 1 ? ` ±${fmtPct(e.rps.cv, { signed: false })}` : '';
      rows.push([
        variant,
        withDelta(`${fmtNumber(e.rps.median)}${cvText}`, d.rps ?? undefined),
        withDelta(fmtNumber(e.p50Us.median), d.p50Us ?? undefined),
        withDelta(fmtNumber(e.p99Us.median), d.p99Us ?? undefined),
        withDelta(fmtNumber(e.cpuUsPerReq.median, 1), d.cpuUsPerReq ?? undefined),
        fmtNumber(e.cpuPct.median),
        fmtNumber(e.elu.median, 2),
        withDelta(fmtNumber(e.rssMiB.median), d.rssMiB ?? undefined),
        fmtNumber(e.gcCount.median),
        fmtNumber(e.gcPauseMs.median, 1),
      ]);
    }
    out.push(
      `\n${workload}\n\n` +
        table(
          [
            'variant',
            'rps',
            'p50 µs',
            'p99 µs',
            'CPU µs/req',
            'CPU %',
            'ELU',
            'RSS MiB',
            'GC n',
            'GC ms',
          ],
          rows,
        ),
    );
  }
  return out.join('\n');
}

async function main() {
  const opts = parseCli();
  const agent = resolveAgent();
  const cellCount = opts.rounds * opts.workloads.length * opts.variants.length;
  const perCell = (opts.durationMs + opts.warmupMs) / 1000 + 0.5;
  process.stderr.write(
    `[bench] ${cellCount} cells, about ${Math.ceil((cellCount * perCell) / 60)} min ` +
      `(node ${process.version}, ${opts.connections} connections)\n`,
  );
  const startedAt = new Date().toISOString();
  const cells = [];
  for (let round = 0; round < opts.rounds; round += 1) {
    // Rotate the variant order every round so no variant always runs first (or last).
    const order = opts.variants.map((_, i) => opts.variants[(i + round) % opts.variants.length]);
    for (const workload of opts.workloads) {
      for (const variant of order) {
        const cell = await runCell(opts, agent, workload, variant, round);
        cells.push(cell);
        process.stderr.write(
          `[bench] round ${round + 1}/${opts.rounds} ${workload}/${variant}: ` +
            (cell.ok
              ? `${fmtNumber(cell.client.rps)} rps, p50 ${fmtNumber(cell.client.p50Us)} µs`
              : `FAILED ${cell.error}`) +
            '\n',
        );
      }
    }
  }
  const summary = summarize(cells, opts);
  const result = {
    schema: 1,
    tool: 'argus bench/overhead.mjs',
    startedAt,
    finishedAt: new Date().toISOString(),
    commit: gitCommit(),
    node: process.version,
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    cpus: { model: os.cpus()[0]?.model ?? 'unknown', count: os.cpus().length },
    loadavg: os.loadavg(),
    settings: {
      durationMs: opts.durationMs,
      warmupMs: opts.warmupMs,
      connections: opts.connections,
      rounds: opts.rounds,
      workloads: opts.workloads,
      variants: opts.variants,
      nodeArgs: opts.nodeArgs,
    },
    summary,
    cells,
  };
  await writeFile(opts.out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `Argus agent overhead — node ${process.version}, ${result.platform}, ${result.cpus.count} × ${result.cpus.model}\n` +
      `${opts.connections} connections, ${opts.durationMs / 1000} s measured after ${opts.warmupMs / 1000} s warm-up, ` +
      `median of ${opts.rounds} round(s); ± is the rps coefficient of variation; deltas are versus "none".\n` +
      render(summary, opts) +
      `\n\nJSON: ${opts.out}\n`,
  );
  const failed = cells.filter((c) => !c.ok);
  if (failed.length > 0) {
    process.stderr.write(`[bench] ${failed.length} cell(s) failed; see "error" in the JSON.\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`[bench] ${describe(err)}\n`);
  process.exitCode = 1;
});
