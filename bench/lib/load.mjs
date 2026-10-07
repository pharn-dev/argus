// Closed-loop HTTP load generator: `connections` keep-alive sockets, each with exactly one request
// in flight. Latency goes into an HDR histogram from perf_hooks (Node core), in nanoseconds.
import http from 'node:http';
import { createHistogram } from 'node:perf_hooks';

const HOST = '127.0.0.1';
/** One request in seven carries a W3C traceparent, so the agent's continue-trace path is exercised. */
const TRACEPARENT_EVERY = 7;
const REQUEST_TIMEOUT_MS = 10_000;

function traceparent(i) {
  const n = (i + 1).toString(16);
  return `00-${n.padStart(32, '0')}-${n.padStart(16, '0')}-01`;
}

/**
 * Start the load immediately (warm-up). Call `startMeasure()` / `endMeasure()` around the measured
 * window, then `stop()` to let in-flight requests finish and close the sockets.
 * @param {{ port: number, connections: number, pathFor: (i: number) => string }} options
 */
export function createLoad({ port, connections, pathFor }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: connections });
  const histogram = createHistogram();
  let measuring = false;
  let stopped = false;
  let seq = 0;
  let completed = 0;
  let errors = 0;
  let totalErrors = 0;
  let firstError;
  let measureStart = 0n;

  const recordError = (err) => {
    totalErrors += 1;
    if (measuring) errors += 1;
    firstError ??= err instanceof Error ? err.message : String(err);
  };

  function once() {
    return new Promise((resolve) => {
      const i = seq;
      seq += 1;
      const headers = i % TRACEPARENT_EVERY === 0 ? { traceparent: traceparent(i) } : {};
      const started = process.hrtime.bigint();
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        if (err !== undefined) {
          recordError(err);
        } else if (measuring) {
          histogram.record(process.hrtime.bigint() - started);
          completed += 1;
        }
        resolve();
      };
      const req = http.request({ agent, host: HOST, port, path: pathFor(i), headers }, (res) => {
        res.on('error', settle);
        res.on('close', () => {
          if (!res.complete) settle(new Error('response closed before it completed'));
          else if (res.statusCode !== 200) settle(new Error(`HTTP ${String(res.statusCode)}`));
          else settle();
        });
        res.resume();
      });
      req.on('error', settle);
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error(`no response within ${REQUEST_TIMEOUT_MS} ms`));
      });
      req.end();
    });
  }

  async function loop() {
    while (!stopped) await once();
  }
  const loops = Array.from({ length: connections }, () => loop());

  return {
    startMeasure() {
      histogram.reset();
      completed = 0;
      errors = 0;
      measureStart = process.hrtime.bigint();
      measuring = true;
    },
    endMeasure() {
      measuring = false;
      const elapsedNs = Number(process.hrtime.bigint() - measureStart);
      return {
        requests: completed,
        elapsedNs,
        rps: completed / (elapsedNs / 1e9),
        p50Us: completed === 0 ? 0 : histogram.percentile(50) / 1000,
        p99Us: completed === 0 ? 0 : histogram.percentile(99) / 1000,
        maxUs: completed === 0 ? 0 : histogram.max / 1000,
        errors,
      };
    },
    /** Totals since the load started (warm-up included), for progress and failure reporting. */
    totals() {
      return { requests: seq, errors: totalErrors, firstError };
    },
    async stop() {
      stopped = true;
      await Promise.all(loops);
      agent.destroy();
    },
  };
}
