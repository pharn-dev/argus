// Soak target: the monitored application. Started by bench/soak.mjs with
// `--expose-gc --import argus/agent`, ARGUS_INTERVAL_MS (default 100) and ARGUS_OUTPUT=stdout; the
// agent's NDJSON goes to stdout, which the harness pipes into the collector process.
import http from 'node:http';
import { describe } from './common.mjs';
import { die, send, serve } from './ipc.mjs';
import { heapAfterGc, resourceSnapshot, trackWorkers } from './resources.mjs';
import { createHandler } from './workloads.mjs';

trackWorkers();

let handled = 0;
let errors = 0;
let firstError;
const onError = (err) => {
  errors += 1;
  firstError ??= describe(err);
};

// One request in eight stalls a Writable (backpressure probe churn); the rest is a mix of the
// benchmark workloads. Every request path is unique (route-cardinality pressure on the agent).
const MIX = ['stall', 'promise', 'stream', 'trivial', 'trivial', 'trivial', 'cpu', 'trivial'];
const handlers = Object.fromEntries(MIX.map((w) => [w, createHandler(w, onError)]));

const server = http.createServer({ keepAliveTimeout: 60_000 }, (req, res) => {
  const workload = MIX[handled % MIX.length];
  handled += 1;
  handlers[workload](req, res);
});
server.on('clientError', (err, socket) => {
  onError(new Error(`clientError: ${describe(err)}`));
  socket.destroy();
});

function closeServer() {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
}

async function main() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  serve({
    async heap() {
      return { type: 'heap', heapUsed: await heapAfterGc(), rss: process.memoryUsage.rss() };
    },
    stats() {
      return {
        type: 'stats',
        handled,
        errors,
        heapUsed: process.memoryUsage().heapUsed,
        rss: process.memoryUsage.rss(),
      };
    },
    async close() {
      await closeServer();
      return { type: 'closed', handled, errors, firstError, ...resourceSnapshot() };
    },
    exit() {
      // Drop the IPC channel and let the process end on its own: lingering handles would keep it
      // alive, and the harness treats that as a leak.
      process.disconnect();
    },
  });
  await send({ type: 'ready', port: server.address().port });
}

main().catch(die);
