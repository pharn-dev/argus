// Benchmark target: one HTTP server running one workload, under one agent variant. Forked by
// bench/overhead.mjs; measures itself between the parent's 'start' and 'stop' requests.
//
// Variants that preload the agent (`idle`, `full`) get `--import argus/agent` from the parent.
// `tracing` and `samplers` load the library API (no auto-start) here, from BENCH_AGENT_INDEX.
import { createWriteStream } from 'node:fs';
import http from 'node:http';
import { devNull } from 'node:os';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { describe } from './common.mjs';
import { die, send, serve } from './ipc.mjs';
import { createHandler } from './workloads.mjs';

const SAMPLE_INTERVAL_MS = 1000;
const workload = process.env.BENCH_WORKLOAD ?? '';
const variant = process.env.BENCH_VARIANT ?? '';

/** NDJSON to /dev/null through the agent's own exporter, as the auto-started agent would do. */
function devNullExporter(agent) {
  const exporter = agent.createNdjsonExporter(createWriteStream(devNull));
  exporter.done.then(undefined, (err) => die(new Error(`exporter failed: ${describe(err)}`)));
  return exporter;
}

async function setUpVariant() {
  if (variant !== 'tracing' && variant !== 'samplers') return;
  const indexUrl = process.env.BENCH_AGENT_INDEX;
  if (indexUrl === undefined) throw new Error('BENCH_AGENT_INDEX is not set');
  const agent = await import(indexUrl);
  const exporter = devNullExporter(agent);
  if (variant === 'tracing') {
    // HTTP tracing only: spans drained once per interval, like the auto-started agent does.
    agent.enable();
    const spans = agent.createSpanExport(agent.drainSpans, (record) => exporter.export(record));
    setInterval(() => spans.flush(), SAMPLE_INTERVAL_MS).unref();
  } else {
    // Samplers and the backpressure probe only; HTTP tracing stays off.
    agent.createSamplerController((sample) => exporter.export(sample)).start(SAMPLE_INTERVAL_MS);
  }
}

let handled = 0;
let errors = 0;
let firstError;
let gcCount = 0;
let gcPauseUs = 0;

new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcCount += 1;
    gcPauseUs += Math.round(entry.duration * 1000);
  }
}).observe({ entryTypes: ['gc'] });

const handler = createHandler(workload, (err) => {
  errors += 1;
  firstError ??= describe(err);
});

let baseline;

async function main() {
  await setUpVariant();
  const server = http.createServer({ keepAliveTimeout: 60_000 }, (req, res) => {
    handled += 1;
    handler(req, res);
  });
  server.on('clientError', (err, socket) => {
    errors += 1;
    firstError ??= `clientError: ${describe(err)}`;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  serve({
    start() {
      baseline = {
        handled,
        errors,
        gcCount,
        gcPauseUs,
        cpu: process.cpuUsage(),
        elu: performance.eventLoopUtilization(),
        at: process.hrtime.bigint(),
      };
      return { type: 'started' };
    },
    stop() {
      if (baseline === undefined) throw new Error('stop before start');
      const cpu = process.cpuUsage(baseline.cpu);
      return {
        type: 'stats',
        requests: handled - baseline.handled,
        wallUs: Math.round(Number(process.hrtime.bigint() - baseline.at) / 1000),
        cpuUserUs: cpu.user,
        cpuSystemUs: cpu.system,
        elu: performance.eventLoopUtilization(baseline.elu).utilization,
        rssBytes: process.memoryUsage.rss(),
        gcCount: gcCount - baseline.gcCount,
        gcPauseUs: gcPauseUs - baseline.gcPauseUs,
        errors: errors - baseline.errors,
        firstError,
      };
    },
    exit() {
      server.closeAllConnections();
      server.close();
      process.exit(0);
    },
  });
  await send({ type: 'ready', port: server.address().port });
}

main().catch(die);
