import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Collector } from '../collector/index.js';
import {
  SESSION_COOKIE,
  bearerToken,
  cookieValues,
  createHostPolicy,
  isLoopbackHost,
  sessionValueFor,
  tokensMatch,
  type HostPolicy,
} from './auth.js';
import { createClientErrorReporter } from './client-error-reporter.js';
import {
  ERROR_SECURITY_HEADERS,
  EVENTS_SECURITY_HEADERS,
  STATIC_SECURITY_HEADERS,
} from './security-headers.js';
import { createSseClient, type SseClient } from './sse-client.js';
import { formatEvent } from './sse-format.js';
import { createStaticAssets, type StaticAsset } from './static-assets.js';

export type DashboardServerOptions = {
  collector: Collector;
  host: string;
  port: number;
  /**
   * Required off loopback. A browser opens `/?token=<token>` once and gets an HttpOnly session
   * cookie in exchange; API clients send `Authorization: Bearer <token>`.
   */
  token?: string;
  /**
   * Extra `Host` values to answer, beyond the bind address (and, for a loopback or any-address
   * bind, `localhost`, `127.0.0.1` and `[::1]`) on the bound port. A bare hostname matches on any
   * port; `host:port` matches exactly. Needed behind a reverse proxy or when reached by name.
   */
  allowedHosts?: readonly string[];
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
/** At most one malformed-request report (plus one summary) per this many milliseconds. */
const CLIENT_ERROR_REPORT_INTERVAL_MS = 10_000;

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
  res.writeHead(status, {
    ...ERROR_SECURITY_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...extra,
  });
  res.end(body);
}

/** A bodyless raw response for a connection the HTTP parser gave up on. */
function rawErrorResponse(error: NodeJS.ErrnoException): string {
  const [status, reason] =
    error.code === 'HPE_HEADER_OVERFLOW'
      ? [431, 'Request Header Fields Too Large']
      : error.code === 'ERR_HTTP_REQUEST_TIMEOUT'
        ? [408, 'Request Timeout']
        : [400, 'Bad Request'];
  const headers = Object.entries(ERROR_SECURITY_HEADERS)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
  return `HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n${headers}\r\n`;
}

export async function createDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServer> {
  const { collector, host, port, token } = options;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
  const allowedHosts = options.allowedHosts ?? [];
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
  if (!Array.isArray(allowedHosts)) {
    throw new RangeError('allowedHosts must be an array of host names');
  }
  // Validates every entry before anything binds; rebuilt with the bound port once listening.
  let hostPolicy: HostPolicy = createHostPolicy(host, port, allowedHosts);

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
  const clientErrors = createClientErrorReporter(report, CLIENT_ERROR_REPORT_INTERVAL_MS);

  const assets = createStaticAssets();
  const sessionValue = token === undefined ? undefined : sessionValueFor(token);

  const authenticated = (req: IncomingMessage): boolean => {
    if (token === undefined || sessionValue === undefined) {
      return true;
    }
    const bearer = bearerToken(req);
    if (bearer !== undefined && tokensMatch(bearer, token)) {
      return true;
    }
    return cookieValues(req, SESSION_COOKIE).some((value) => tokensMatch(value, sessionValue));
  };

  const unauthorized = (res: ServerResponse): void => {
    plain(res, 401, 'unauthorized\n', { 'www-authenticate': 'Bearer' });
  };

  /** `GET /?token=…`: trade a correct token for the session cookie and a clean URL. */
  const exchangeToken = (req: IncomingMessage, res: ServerResponse, presented: string): void => {
    if (token === undefined || sessionValue === undefined || !tokensMatch(presented, token)) {
      unauthorized(res);
      return;
    }
    const secure = (req.socket as { encrypted?: unknown }).encrypted === true ? '; Secure' : '';
    plain(res, 303, 'see other\n', {
      location: '/',
      'set-cookie': `${SESSION_COOKIE}=${sessionValue}; HttpOnly; SameSite=Strict; Path=/${secure}`,
    });
  };

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
      ...EVENTS_SECURITY_HEADERS,
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
    const spans = collector.spans.snapshot();
    const unsubscribe = collector.subscribe({
      window: (w): void => client.send(formatEvent('window', w)),
      alert: (a): void => client.send(formatEvent('alert', a)),
      span: (s): void => client.send(formatEvent('span', s)),
    });
    for (const w of windows) {
      client.send(formatEvent('window', w));
    }
    for (const a of alerts) {
      client.send(formatEvent('alert', a));
    }
    for (const s of spans) {
      client.send(formatEvent('span', s));
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
    // DNS rebinding defence: answer only the hosts this server is reachable as.
    if (!hostPolicy.hostAllowed(req.headers.host)) {
      res.writeHead(421, { ...ERROR_SECURITY_HEADERS, 'content-length': '0', connection: 'close' });
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    if (
      origin !== undefined &&
      (url.pathname === '/events' || req.method !== 'GET') &&
      !hostPolicy.originAllowed(origin)
    ) {
      plain(res, 403, 'forbidden\n');
      return;
    }
    if (token !== undefined) {
      const presented = url.searchParams.get('token');
      if (presented !== null) {
        // The token rides in a URL only on its way to becoming a cookie, and only to the page.
        if (url.pathname === '/' && req.method === 'GET') {
          exchangeToken(req, res, presented);
        } else {
          unauthorized(res);
        }
        return;
      }
      if (!authenticated(req)) {
        unauthorized(res);
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
  server.on('clientError', (error: NodeJS.ErrnoException, socket: Duplex) => {
    // An abrupt disconnect is routine; anything else is reported, rate-limited, because any
    // unauthenticated client can send malformed requests as fast as it likes.
    if (!isDisconnect(error)) {
      clientErrors.record(error);
    }
    if (error.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    socket.end(rawErrorResponse(error), () => {
      socket.destroy();
    });
  });

  const boundPort = (server.address() as AddressInfo).port;
  hostPolicy = createHostPolicy(host, boundPort, allowedHosts);
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
        clientErrors.close();
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
