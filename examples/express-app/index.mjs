import { createCollector, createNdjsonDecoder } from '@pharn-dev/phargus/collector';
import { createDashboardServer } from '@pharn-dev/phargus/dashboard';
import { fork } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// The parent process: it starts the monitored app (app.mjs, which loads the agent), reads the
// agent's NDJSON from the app's stdout into a collector, and serves the dashboard.

const PREFIX = '[express-app] ';
const HOST = '127.0.0.1';
const DEFAULT_APP_PORT = 3000;
const DEFAULT_DASHBOARD_PORT = 7070;
const DEFAULT_INTERVAL_MS = '250';
const MAX_LINE_BYTES = 1024 * 1024;
const STARTUP_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const ALERT_THRESHOLD_NS = 50_000_000;

function describe(err) {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function logError(line) {
  process.stderr.write(`${PREFIX}${line}\n`);
}

function readPort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) > 65535) {
    throw new Error(`${name} must be an integer from 0 to 65535, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

// Resolve with { error } instead of rejecting, so every outcome is collected, none is lost.
function settle(promise) {
  return promise.then(
    () => ({ error: undefined }),
    (error) => ({ error }),
  );
}

function waitForListening(child, exited) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`the app did not report its port within ${STARTUP_TIMEOUT_MS} ms`)),
      );
    }, STARTUP_TIMEOUT_MS);
    const onMessage = (message) => {
      if (
        message !== null &&
        typeof message === 'object' &&
        message.type === 'listening' &&
        Number.isInteger(message.port)
      ) {
        finish(() => resolve(message.port));
      }
    };
    function finish(settleNow) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      settleNow();
    }
    child.on('message', onMessage);
    void exited.then(() =>
      finish(() => reject(new Error('the app exited before it was listening'))),
    );
  });
}

async function main() {
  const appPort = readPort('APP_PORT', DEFAULT_APP_PORT);
  const dashboardPort = readPort('DASHBOARD_PORT', DEFAULT_DASHBOARD_PORT);

  const errors = [];
  const fail = (err) => {
    errors.push(err);
    logError(`failed: ${describe(err)}`);
  };

  const child = fork(fileURLToPath(new URL('./app.mjs', import.meta.url)), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      PHARGUS_OUTPUT: 'stdout',
      PHARGUS_INTERVAL_MS: process.env.PHARGUS_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
      APP_PORT: String(appPort),
    },
  });

  let stopping = false;
  let childExit;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      childExit = { code, signal };
      resolve(childExit);
    });
    child.on('error', (err) => {
      fail(err);
      // A child that never started has no pid and will never emit 'exit'.
      if (child.pid === undefined) resolve(undefined);
    });
  });

  const collector = createCollector({
    windowMs: 1000,
    capacity: 120,
    alerts: [
      {
        id: 'event-loop-lag',
        metric: 'eventLoop.max',
        comparison: '>=',
        threshold: ALERT_THRESHOLD_NS,
      },
    ],
  });
  // The app may log to its own stdout too: the decoder skips lines that are not JSON objects, the
  // collector skips objects that are not agent records, and both count what they skip.
  const decoder = createNdjsonDecoder({ maxLineBytes: MAX_LINE_BYTES });
  const consumed = settle(pipeline(child.stdout, decoder, (records) => collector.consume(records)));
  const stderrForwarded = settle(pipeline(child.stderr, process.stderr, { end: false }));

  let dashboard;
  let finishRun;
  const runEnded = new Promise((resolve) => {
    finishRun = resolve;
  });

  let shutdownPromise;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      stopping = true;
      const hangTimer = setTimeout(() => {
        logError(`failed: shutdown took longer than ${SHUTDOWN_TIMEOUT_MS} ms; killing the app`);
        child.kill('SIGKILL');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      hangTimer.unref();

      if (childExit === undefined) {
        const sent = child.connected && child.send({ type: 'shutdown' }, () => {});
        if (!sent) child.kill('SIGTERM');
      }
      await exited;
      for (const result of await Promise.all([consumed, stderrForwarded])) {
        if (result.error !== undefined) fail(result.error);
      }
      if (decoder.invalid > 0 || decoder.oversized > 0 || collector.ignored > 0) {
        logError(
          `skipped ${decoder.invalid} non-JSON lines, ${decoder.oversized} oversized lines and ${collector.ignored} non-agent records from the app's stdout`,
        );
      }
      if (dashboard !== undefined) {
        const closed = await settle(dashboard.close());
        if (closed.error !== undefined) fail(closed.error);
      }
      const collectorClosed = await settle(collector.close());
      if (collectorClosed.error !== undefined) fail(collectorClosed.error);
      if (childExit !== undefined && (childExit.code !== 0 || childExit.signal !== null)) {
        fail(
          new Error(
            `the app exited with code ${String(childExit.code)}, signal ${String(childExit.signal)}`,
          ),
        );
      }
      clearTimeout(hangTimer);
      finishRun();
    })();
    return shutdownPromise;
  };

  child.once('exit', () => {
    if (!stopping) {
      logError('failed: the app exited unexpectedly');
      errors.push(new Error('the app exited unexpectedly'));
      void shutdown();
    }
  });
  consumed.then((result) => {
    // The pipeline ends with the app's stdout; a failure there stops everything.
    if (result.error !== undefined && !stopping) void shutdown();
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      void shutdown();
    });
  }

  try {
    const port = await waitForListening(child, exited);
    dashboard = await createDashboardServer({
      collector,
      host: HOST,
      port: dashboardPort,
      onError: (err) => logError(`dashboard error: ${describe(err)}`),
    });
    process.stdout.write(`${PREFIX}app listening on http://${HOST}:${port}\n`);
    process.stdout.write(`${PREFIX}dashboard listening on http://${HOST}:${dashboard.port}\n`);
  } catch (err) {
    fail(err);
    void shutdown();
  }

  await runEnded;
  process.exitCode = errors.length === 0 ? 0 : 1;
}

main().catch((err) => {
  logError(`failed: ${describe(err)}`);
  process.exitCode = 1;
});
