import 'argus/agent';
import { channel } from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

// The monitored app. The agent (loaded by the line above) writes NDJSON to this process's stdout,
// so nothing else here may write to stdout. The parent (index.mjs) reads that stream.

const HOST = '127.0.0.1';
const SLOW_BLOCK_MS = 200;
const PREFIX = '[express-app:app] ';

function describe(err) {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function logError(line) {
  process.stderr.write(`${PREFIX}${line}\n`);
}

// Block the event loop with bounded integer work, so the agent sees event loop lag.
function blockEventLoop(ms) {
  const end = performance.now() + ms;
  let acc = 0;
  while (performance.now() < end) {
    for (let i = 0; i < 10_000; i += 1) {
      acc = (acc + i * 31) % 1_000_003;
    }
  }
  return acc;
}

function text(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function handle(req, res) {
  const { pathname } = new URL(req.url ?? '/', `http://${HOST}`);
  if (req.method === 'GET' && pathname === '/fast') {
    text(res, 200, 'fast\n');
  } else if (req.method === 'GET' && pathname === '/slow') {
    blockEventLoop(SLOW_BLOCK_MS);
    text(res, 200, 'slow\n');
  } else if (req.method === 'GET' && pathname === '/error') {
    text(res, 500, 'error\n');
  } else {
    text(res, 404, 'not found\n');
  }
}

// The agent starts asynchronously (it reads its config first) and turns HTTP tracing on only
// afterwards. A request served before that would get no span, so the app waits until the agent
// has subscribed to Node's HTTP response channel before it reports itself ready. If that never
// happens (for example the agent is disabled by an argus.config file), serve anyway after a
// bounded wait and say so on stderr.
const AGENT_READY_TIMEOUT_MS = 10_000;
const AGENT_POLL_MS = 5;

async function agentIsTracing(isStopped) {
  const finish = channel('http.server.response.finish');
  const deadline = performance.now() + AGENT_READY_TIMEOUT_MS;
  while (!finish.hasSubscribers) {
    if (isStopped() || performance.now() >= deadline) return false;
    await sleep(AGENT_POLL_MS);
  }
  return true;
}

function parsePort(value) {
  if (value === undefined || !/^[0-9]{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  return port <= 65535 ? port : undefined;
}

const port = parsePort(process.env.APP_PORT);
if (port === undefined) {
  logError('APP_PORT must be an integer from 0 to 65535');
  process.exitCode = 1;
} else {
  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      logError(`request failed: ${describe(err)}`);
      if (!res.headersSent) {
        text(res, 500, 'internal error\n');
      } else {
        res.destroy();
      }
    }
  });

  server.on('clientError', (err, socket) => {
    logError(`client error: ${err.message}`);
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close((err) => {
      if (err !== undefined && err.code !== 'ERR_SERVER_NOT_RUNNING') {
        logError(`close failed: ${describe(err)}`);
        process.exitCode = 1;
      }
    });
    server.closeAllConnections();
    if (process.connected) process.disconnect();
  };

  server.on('error', (err) => {
    logError(`server error: ${describe(err)}`);
    process.exitCode = 1;
    shutdown();
  });

  process.on('message', (message) => {
    if (message !== null && typeof message === 'object' && message.type === 'shutdown') {
      shutdown();
    }
  });
  process.on('disconnect', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  const tracing = await agentIsTracing(() => shuttingDown);
  if (!tracing && !shuttingDown) {
    logError('the agent is not tracing HTTP requests yet; serving without waiting for it');
  }

  if (!shuttingDown) {
    server.listen(port, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        logError('server has no TCP address');
        process.exitCode = 1;
        shutdown();
        return;
      }
      if (typeof process.send !== 'function') {
        logError('no IPC channel: start this app through index.mjs');
        process.exitCode = 1;
        shutdown();
        return;
      }
      process.send({ type: 'listening', port: address.port }, (err) => {
        if (err !== null) {
          logError(`could not report the port: ${err.message}`);
          process.exitCode = 1;
          shutdown();
        }
      });
    });
  }
}
