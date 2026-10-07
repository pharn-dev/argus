// Soak target: the analysis side. Started by bench/soak.mjs with --expose-gc; reads the agent's
// NDJSON on stdin into a collector and, for the whole run, keeps every other module busy:
//   - argus/dashboard serves the collector; the harness churns SSE clients against it;
//   - argus/otel exporters flood a dead endpoint (bounded queues must drop, not grow);
//   - argus/analyzer symbolizes on a persistent pool and on a fresh pool per call (worker churn);
//   - argus/plugin-runner runs the built-in rules, plus a rule that times out (sandbox respawn).
import { once } from 'node:events';
import http from 'node:http';
import { createSymbolizationPool, symbolizeStackFrames } from 'argus/analyzer';
import { createCollector } from 'argus/collector';
import { createDashboardServer } from 'argus/dashboard';
import { createOtlpMetricsExporter, createOtlpTraceExporter } from 'argus/otel';
import {
  createPluginRunner,
  eventLoopLagRule,
  gcPauseShareRule,
  heapGrowthRule,
  runRules,
} from 'argus/plugin-runner';
import { describe, sleep } from './common.mjs';
import { die, send, serve } from './ipc.mjs';
import { heapAfterGc, resourceSnapshot, trackWorkers } from './resources.mjs';

trackWorkers();

const WINDOW_MS = 200;
// Small rings, so they are full long before the heap baseline is taken.
const WINDOW_CAPACITY = 16;
const SPAN_CAPACITY = 256;
const MAX_LINE_LENGTH = 1024 * 1024;
const FLOOD_EVERY_MS = 100;
const FLOOD_BATCHES = 500;
const EXPORT_TIMEOUT_MS = 200;
const EXPORT_QUEUE = 8;
const SYMBOLIZE_EVERY_MS = 500;
const FRESH_POOL_EVERY = 4;
const RULES_EVERY_MS = 1000;
const TIMEOUT_RULE_EVERY = 5;
const TIMEOUT_RULE = { id: 'soak-timeout', source: 'for (;;) {}' };

const counters = {
  lines: 0,
  windows: 0,
  spans: 0,
  exportErrors: 0,
  dashboardErrors: 0,
  symbolizeOk: 0,
  symbolizeFailed: 0,
  ruleOk: 0,
  ruleFailed: {},
};
const errorSamples = {};
function note(kind, err) {
  errorSamples[kind] ??= describe(err).split('\n')[0];
}

/** The agent's stdout as parsed NDJSON objects; a malformed or oversized line is an error. */
async function* decodeNdjson(source) {
  source.setEncoding('utf8');
  let pending = '';
  for await (const chunk of source) {
    pending += chunk;
    let start = 0;
    let newline = pending.indexOf('\n', start);
    while (newline !== -1) {
      const line = pending.slice(start, newline);
      start = newline + 1;
      newline = pending.indexOf('\n', start);
      if (line.trim() === '') continue;
      counters.lines += 1;
      yield JSON.parse(line);
    }
    pending = pending.slice(start);
    if (pending.length > MAX_LINE_LENGTH) throw new Error('NDJSON line longer than 1 MiB');
  }
}

/** A port nothing listens on: connections are refused, as with a collector that is down. */
async function deadPort() {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  return port;
}

/** Run `task` every `ms` until stopped; never overlapping, every failure counted by the task. */
function repeat(ms, task) {
  let stopped = false;
  const done = (async () => {
    for (let tick = 0; !stopped; tick += 1) {
      await task(tick);
      await sleep(ms);
    }
  })();
  return {
    stop() {
      stopped = true;
      return done;
    },
  };
}

async function main() {
  const collector = createCollector({
    windowMs: WINDOW_MS,
    capacity: WINDOW_CAPACITY,
    spanCapacity: SPAN_CAPACITY,
  });
  collector.subscribe({
    window: () => {
      counters.windows += 1;
    },
    span: () => {
      counters.spans += 1;
    },
  });
  const consumed = collector.consume(decodeNdjson(process.stdin));

  const dashboard = await createDashboardServer({
    collector,
    host: '127.0.0.1',
    port: 0,
    onError: (err) => {
      counters.dashboardErrors += 1;
      note('dashboard', err);
    },
  });

  const dead = `http://127.0.0.1:${await deadPort()}`;
  const exporterOptions = {
    timeoutMs: EXPORT_TIMEOUT_MS,
    queueCapacity: EXPORT_QUEUE,
    onError: (err) => {
      counters.exportErrors += 1;
      note('export', err);
    },
  };
  const metricsExporter = createOtlpMetricsExporter({
    ...exporterOptions,
    url: `${dead}/v1/metrics`,
  });
  const traceExporter = createOtlpTraceExporter({ ...exporterOptions, url: `${dead}/v1/traces` });
  collector.subscribe(metricsExporter.listener);
  collector.subscribe(traceExporter.listener);
  const flood = setInterval(() => {
    const [window] = collector.windows.snapshot().slice(-1);
    const [span] = collector.spans.snapshot().slice(-1);
    for (let i = 0; i < FLOOD_BATCHES; i += 1) {
      if (window !== undefined) metricsExporter.export(window);
      if (span !== undefined) traceExporter.export(span);
    }
  }, FLOOD_EVERY_MS);

  const frames = [{ url: import.meta.resolve('argus/agent'), line: 1, column: 1 }];
  const pool = createSymbolizationPool({ size: 2 });
  const symbolizer = repeat(SYMBOLIZE_EVERY_MS, async (tick) => {
    try {
      // Every few ticks a fresh pool: one Worker created and terminated per call.
      await symbolizeStackFrames(frames, tick % FRESH_POOL_EVERY === 0 ? {} : { pool });
      counters.symbolizeOk += 1;
    } catch (err) {
      counters.symbolizeFailed += 1;
      note('symbolize', err);
    }
  });

  const runner = createPluginRunner({ timeoutMs: 500, memoryLimitMb: 16 });
  const builtins = [eventLoopLagRule(), heapGrowthRule(), gcPauseShareRule()];
  const rules = repeat(RULES_EVERY_MS, async (tick) => {
    const set = tick % TIMEOUT_RULE_EVERY === 0 ? [...builtins, TIMEOUT_RULE] : builtins;
    const results = await runRules(runner, set, collector.windows.snapshot());
    for (const result of Object.values(results)) {
      if (result.ok) {
        counters.ruleOk += 1;
      } else {
        counters.ruleFailed[result.error.code] = (counters.ruleFailed[result.error.code] ?? 0) + 1;
      }
    }
  });

  let closed = false;
  serve({
    async heap() {
      return { type: 'heap', heapUsed: await heapAfterGc(), rss: process.memoryUsage.rss() };
    },
    stats() {
      return {
        type: 'stats',
        ...counters,
        clientCount: dashboard.clientCount,
        heapUsed: process.memoryUsage().heapUsed,
      };
    },
    async close() {
      clearInterval(flood);
      await symbolizer.stop();
      await rules.stop();
      const clientCount = dashboard.clientCount;
      const droppedEvents = dashboard.droppedEvents;
      await runner.close();
      await pool.close();
      await Promise.all([metricsExporter.close(), traceExporter.close()]);
      await dashboard.close();
      closed = true;
      return {
        type: 'closed',
        counters,
        errorSamples,
        clientCountBeforeClose: clientCount,
        droppedEvents,
        exporters: {
          metrics: {
            dropped: metricsExporter.droppedBatches,
            failed: metricsExporter.failedBatches,
          },
          traces: { dropped: traceExporter.droppedBatches, failed: traceExporter.failedBatches },
        },
        ...resourceSnapshot(),
      };
    },
    exit() {
      if (!closed) throw new Error('exit before close');
      // stdin ends when the app exits; then the collector settles and nothing should be left.
      process.disconnect();
    },
  });

  consumed
    .then(() => collector.close())
    .catch((err) => die(new Error(`collector failed: ${describe(err)}`)));
  await send({ type: 'ready', dashboardPort: dashboard.port, windowMs: WINDOW_MS });
}

main().catch(die);
