import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Collector } from '../collector/index.js';
import { isLoopbackHost, presentedToken, tokensMatch } from './auth.js';
import { STATIC_SECURITY_HEADERS } from './security-headers.js';
import { createSseClient, type SseClient } from './sse-client.js';
import { formatEvent } from './sse-format.js';
import { createStaticAssets, type StaticAsset } from './static-assets.js';

export type DashboardServerOptions = {
  collector: Collector;
  host: string;
  port: number;
  token?: string;
  heartbeatMs?: number;
  maxBufferedEvents?: number;
  onError?: (error: Error) => void;
};

export type DashboardServer = {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly clientCount: number;
  readonly droppedEvents: number;
  close(): Promise<void>;
};

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_BUFFERED_EVENTS = 1000;

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function isDisconnect(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ECONNRESET' || error.message === 'aborted';
}

function plain(
  res: ServerResponse,
  status: number,
  body: string,
  extra?: Record<string, string>,
): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...extra });
  res.end(body);
}

export async function createDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServer> {
  const { collector, host, port, token } = options;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
  requirePositiveInteger('heartbeatMs', heartbeatMs);
  requirePositiveInteger('maxBufferedEvents', maxBufferedEvents);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new RangeError('port must be an integer from 0 to 65535');
  }
  if (token !== undefined && (typeof token !== 'string' || token.length === 0)) {
    throw new RangeError('token must be a non-empty string');
  }
  if (!isLoopbackHost(host) && token === undefined) {
    throw new Error(`a token is required to bind the dashboard to non-loopback host "${host}"`);
  }

  const report = (error: Error): void => {
    try {
      if (options.onError !== undefined) {
        options.onError(error);
        return;
      }
    } catch {
      // A throwing handler falls through to the warning below.
    }
    process.emitWarning(`dashboard server error: ${error.message}`);
  };

  const assets = createStaticAssets(token);

  const serveAsset = (req: IncomingMessage, res: ServerResponse, asset: StaticAsset): void => {
    const fail = (error: NodeJS.ErrnoException): void => {
      if (!isDisconnect(error)) {
        report(error);
      }
    };
    req.once('error', fail);
    res.once('error', fail);
    res.once('close', () => {
      req.off('error', fail);
      res.off('error', fail);
    });
    res.writeHead(200, {
      ...STATIC_SECURITY_HEADERS,
      'content-type': asset.contentType,
      'content-length': String(asset.body.byteLength),
    });
    res.end(asset.body);
  };

  let dropped = 0;
  const clients = new Set<SseClient>();
  const cleanups = new Set<() => void>();

  const handleSse = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    const client = createSseClient(res, {
      maxBufferedEvents,
      onDrop: (): void => {
        dropped += 1;
      },
    });
    clients.add(client);

    // Snapshot and subscribe in one synchronous block: nothing is missed or duplicated.
    const windows = collector.windows.snapshot();
    const alerts = collector.alerts.snapshot();
    const unsubscribe = collector.subscribe({
      window: (w): void => client.send(formatEvent('window', w)),
      alert: (a): void => client.send(formatEvent('alert', a)),
    });
    for (const w of windows) {
      client.send(formatEvent('window', w));
    }
    for (const a of alerts) {
      client.send(formatEvent('alert', a));
    }

    let done = false;
    const cleanup = (): void => {
      if (done) {
        return;
      }
      done = true;
      cleanups.delete(cleanup);
      unsubscribe();
      client.end();
      clients.delete(client);
    };
    cleanups.add(cleanup);
    const fail = (error: NodeJS.ErrnoException): void => {
      // An ordinary client disconnect is cleanup, not an error worth a warning.
      if (!isDisconnect(error)) {
        report(error);
      }
      cleanup();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    req.on('error', fail);
    res.on('error', fail);
    res.socket?.on('error', fail);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (token !== undefined) {
      const presented = presentedToken(req, url);
      if (presented === undefined || !tokensMatch(presented, token)) {
        plain(res, 401, 'unauthorized\n', { 'www-authenticate': 'Bearer' });
        return;
      }
    }
    if (url.pathname === '/events') {
      if (req.method === 'GET') {
        handleSse(req, res);
      } else {
        plain(res, 405, 'method not allowed\n', { allow: 'GET' });
      }
      return;
    }
    const asset = assets.get(url.pathname);
    if (asset !== undefined) {
      if (req.method === 'GET') {
        serveAsset(req, res, asset);
      } else {
        plain(res, 405, 'method not allowed\n', { allow: 'GET' });
      }
      return;
    }
    plain(res, 404, 'not found\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', report);
  server.on('clientError', (error, socket) => {
    report(error);
    socket.destroy();
  });

  const boundPort = (server.address() as AddressInfo).port;
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      client.heartbeat();
    }
  }, heartbeatMs);
  heartbeat.unref();

  let closing: Promise<void> | undefined;

  return {
    host,
    port: boundPort,
    url: `http://${urlHost}:${boundPort}`,
    get clientCount(): number {
      return clients.size;
    },
    get droppedEvents(): number {
      return dropped;
    },
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve, reject) => {
        clearInterval(heartbeat);
        for (const cleanup of [...cleanups]) {
          cleanup();
        }
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
          } else {
            resolve();
          }
        });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
