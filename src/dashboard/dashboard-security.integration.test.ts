import { request, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createCollector } from '../collector/index.js';
import { createDashboardServer, type DashboardServer } from './index.js';

// Regression tests for the dashboard's network-facing defences: Host/Origin validation (DNS
// rebinding), the `?token=` → cookie exchange (no token in any URL but the first), the security
// headers on every response, and rate-limited reporting of malformed requests.

const TOKEN = 'tok-9f2c-Very-Secret-Value';

type Result = { status: number; headers: IncomingHttpHeaders; body: string };

const servers: DashboardServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function start(
  options: { token?: string; allowedHosts?: string[]; onError?: (error: Error) => void } = {},
): Promise<DashboardServer> {
  const collector = createCollector({ windowMs: 1000, capacity: 10 });
  const server = await createDashboardServer({ collector, host: '127.0.0.1', port: 0, ...options });
  servers.push(server);
  return server;
}

/**
 * One request over a fresh connection with exactly these headers (Host included when given). An
 * event stream is cut after its headers and first chunk; anything else is read to the end.
 */
function send(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      const done = (): void =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      if ((res.headers['content-type'] ?? '').startsWith('text/event-stream')) {
        // An open stream never ends: its status and headers are the result.
        res.on('error', () => {
          // Destroying the open stream aborts the response; that is not a failure.
        });
        done();
        req.destroy();
        return;
      }
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', done);
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET') {
        reject(error);
      }
    });
    req.setTimeout(5_000, () => req.destroy(new Error(`timed out: ${method} ${path}`)));
    req.end();
  });
}

/** Raw bytes over a fresh socket; resolves with everything the server sent before closing. */
function raw(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.setTimeout(5_000, () => socket.destroy(new Error('raw request timed out')));
    socket.write(payload);
  });
}

function expectErrorHeaders(what: string, headers: IncomingHttpHeaders): void {
  expect(headers['x-content-type-options'], `${what}: nosniff`).toBe('nosniff');
  expect(headers['content-security-policy'] ?? '', `${what}: CSP`).toMatch(
    /(^|;\s*)default-src 'none'(;|$)/,
  );
  expect(headers['referrer-policy'], `${what}: referrer-policy`).toBe('no-referrer');
}

async function login(port: number): Promise<{ setCookie: string; cookie: string }> {
  const response = await send(port, `/?token=${encodeURIComponent(TOKEN)}`, {
    host: `127.0.0.1:${port}`,
  });
  expect(response.status).toBe(303);
  const setCookie = response.headers['set-cookie']?.[0] ?? '';
  return { setCookie, cookie: setCookie.split(';')[0] ?? '' };
}

const ROUTES = ['/', '/app.js', '/app.css', '/events'];

describe('dashboard Host and Origin validation (DNS rebinding)', () => {
  it('answers 421 with no body to a foreign Host on the page, assets and /events', async () => {
    for (const token of [undefined, TOKEN]) {
      const server = await start(token === undefined ? {} : { token });
      const auth: Record<string, string> =
        token === undefined ? {} : { authorization: `Bearer ${token}` };
      for (const path of ROUTES) {
        for (const host of [
          'evil.example.com',
          `evil.example.com:${server.port}`,
          `127.0.0.1.evil.example:${server.port}`,
          `localhost:${server.port + 1 > 65535 ? 1 : server.port + 1}`,
        ]) {
          const response = await send(server.port, path, { ...auth, host });
          const what = `GET ${path} Host: ${host} (token: ${String(token !== undefined)})`;
          expect(response.status, what).toBe(421);
          expect(response.body, `${what}: body`).toBe('');
          expectErrorHeaders(what, response.headers);
        }
      }
    }
  });

  it('answers 421 to a request with no Host header', async () => {
    const server = await start();
    const reply = await raw(server.port, 'GET / HTTP/1.0\r\n\r\n');
    expect(reply.startsWith('HTTP/1.1 421 ')).toBe(true);
    expect(reply).not.toContain('<html');
  });

  it('serves the loopback variants of the bound port', async () => {
    const server = await start();
    for (const host of [
      `127.0.0.1:${server.port}`,
      `localhost:${server.port}`,
      `LOCALHOST:${server.port}`,
      `[::1]:${server.port}`,
    ]) {
      for (const path of ROUTES) {
        const response = await send(server.port, path, { host });
        expect(response.status, `GET ${path} Host: ${host}`).toBe(200);
      }
    }
  });

  it('serves the hosts allowedHosts adds: a bare name on any port, host:port exactly', async () => {
    const server = await start({ allowedHosts: ['dash.example.com', 'proxy.example:8443'] });
    expect((await send(server.port, '/', { host: 'dash.example.com' })).status).toBe(200);
    expect((await send(server.port, '/', { host: 'dash.example.com:9999' })).status).toBe(200);
    expect((await send(server.port, '/', { host: 'proxy.example:8443' })).status).toBe(200);
    expect((await send(server.port, '/', { host: 'proxy.example:8444' })).status).toBe(421);
    expect((await send(server.port, '/', { host: 'other.example.com' })).status).toBe(421);
  });

  it('rejects an invalid allowedHosts entry before binding', async () => {
    const collector = createCollector({ windowMs: 1000, capacity: 10 });
    await expect(
      createDashboardServer({
        collector,
        host: '127.0.0.1',
        port: 0,
        allowedHosts: ['http://bad.example/'],
      }),
    ).rejects.toThrow(/allowedHosts/);
  });

  it('answers 403 to a foreign Origin on /events and on non-GET requests, 200 to its own', async () => {
    const server = await start();
    const host = `127.0.0.1:${server.port}`;
    for (const origin of [
      'http://evil.example.com',
      `http://evil.example.com:${server.port}`,
      'null',
      `http://127.0.0.1:${server.port + 1 > 65535 ? 1 : server.port + 1}`,
    ]) {
      const events = await send(server.port, '/events', { host, origin });
      expect(events.status, `GET /events Origin: ${origin}`).toBe(403);
      expect(events.body).not.toMatch(/^event:/m);
      expectErrorHeaders(`GET /events Origin: ${origin}`, events.headers);
      const post = await send(server.port, '/', { host, origin }, 'POST');
      expect(post.status, `POST / Origin: ${origin}`).toBe(403);
    }
    for (const origin of [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`]) {
      const events = await send(server.port, '/events', { host, origin });
      expect(events.status, `GET /events Origin: ${origin}`).toBe(200);
    }
  });
});

describe('dashboard token exchange (no token in URLs)', () => {
  it('trades ?token= on / for a 303 to / and an HttpOnly SameSite=Strict cookie that is not the token', async () => {
    const server = await start({ token: TOKEN });
    const response = await send(server.port, `/?token=${encodeURIComponent(TOKEN)}`, {
      host: `127.0.0.1:${server.port}`,
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/');
    expectErrorHeaders('303', response.headers);
    const cookies = response.headers['set-cookie'] ?? [];
    expect(cookies).toHaveLength(1);
    const setCookie = cookies[0] ?? '';
    const attributes = setCookie.split(';').map((part) => part.trim().toLowerCase());
    expect(attributes[0]).toMatch(/^argus_token=[A-Za-z0-9_-]{20,}$/i);
    expect(attributes).toContain('httponly');
    expect(attributes).toContain('samesite=strict');
    expect(attributes).toContain('path=/');
    expect(attributes).not.toContain('secure');
    expect(setCookie).not.toContain(TOKEN);
    expect(setCookie).not.toContain(encodeURIComponent(TOKEN));
    expect(setCookie).not.toContain(Buffer.from(TOKEN).toString('base64'));
    expect(setCookie).not.toContain(Buffer.from(TOKEN).toString('base64url'));
  });

  it('answers 401 and sets no cookie for a wrong ?token= on /', async () => {
    const server = await start({ token: TOKEN });
    const response = await send(server.port, '/?token=wrong', {
      host: `127.0.0.1:${server.port}`,
    });
    expect(response.status).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expectErrorHeaders('401', response.headers);
  });

  it('authenticates the page, assets and /events with the cookie, and /events with Bearer', async () => {
    const server = await start({ token: TOKEN });
    const host = `127.0.0.1:${server.port}`;
    const { cookie } = await login(server.port);
    for (const path of ROUTES) {
      const response = await send(server.port, path, { host, cookie });
      expect(response.status, `GET ${path} with the cookie`).toBe(200);
    }
    const events = await send(server.port, '/events', { host, cookie });
    expect(events.headers['content-type']).toMatch(/^text\/event-stream/);
    const bearer = await send(server.port, '/events', { host, authorization: `Bearer ${TOKEN}` });
    expect(bearer.status).toBe(200);
    expect(bearer.headers['content-type']).toMatch(/^text\/event-stream/);
    // A forged or stale cookie does nothing.
    for (const forged of ['argus_token=forged', `argus_token=${TOKEN}`]) {
      const response = await send(server.port, '/events', { host, cookie: forged });
      expect(response.status, forged).toBe(401);
    }
  });

  it('answers 401 to ?token= on /events and the assets, even with the right token or a valid cookie', async () => {
    const server = await start({ token: TOKEN });
    const host = `127.0.0.1:${server.port}`;
    const { cookie } = await login(server.port);
    for (const path of ['/events', '/app.js', '/app.css']) {
      const url = `${path}?token=${encodeURIComponent(TOKEN)}`;
      const bare = await send(server.port, url, { host });
      expect(bare.status, `GET ${url}`).toBe(401);
      expect(bare.body).not.toMatch(/^event:/m);
      expect(bare.headers['set-cookie']).toBeUndefined();
      const withCookie = await send(server.port, url, { host, cookie });
      expect(withCookie.status, `GET ${url} with the cookie`).toBe(401);
    }
  });

  it('serves HTML and JS that hold neither the token nor the cookie value', async () => {
    const server = await start({ token: TOKEN });
    const host = `127.0.0.1:${server.port}`;
    const { cookie } = await login(server.port);
    const cookieValue = cookie.slice(cookie.indexOf('=') + 1);
    for (const path of ['/', '/app.js', '/app.css']) {
      const response = await send(server.port, path, { host, cookie });
      expect(response.status).toBe(200);
      expect(response.body, path).not.toContain(TOKEN);
      expect(response.body, path).not.toContain(encodeURIComponent(TOKEN));
      expect(response.body, path).not.toContain(cookieValue);
    }
    const page = await send(server.port, '/', { host, cookie });
    expect(page.body).not.toMatch(/\?token=/);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('dashboard response headers and malformed requests', () => {
  it('sends nosniff, CSP default-src none and no-referrer on /events and on every error', async () => {
    const server = await start({ token: TOKEN });
    const host = `127.0.0.1:${server.port}`;
    const events = await send(server.port, '/events', { host, authorization: `Bearer ${TOKEN}` });
    expect(events.status).toBe(200);
    expectErrorHeaders('/events', events.headers);

    const errors: [string, Result][] = [
      ['401', await send(server.port, '/events', { host })],
      ['404', await send(server.port, '/nope', { host, authorization: `Bearer ${TOKEN}` })],
      ['405', await send(server.port, '/', { host, authorization: `Bearer ${TOKEN}` }, 'POST')],
      ['421', await send(server.port, '/', { host: 'evil.example.com' })],
    ];
    for (const [what, response] of errors) {
      expect(response.status, what).toBe(Number(what));
      expectErrorHeaders(what, response.headers);
    }
  });

  it('answers malformed requests 400 and reports 100 of them in at most two reports', async () => {
    const reports: Error[] = [];
    const server = await start({ onError: (error) => reports.push(error) });
    const replies = await Promise.all(
      Array.from({ length: 100 }, () => raw(server.port, 'NOT A REQUEST\r\n\r\n')),
    );
    for (const reply of replies) {
      expect(reply.startsWith('HTTP/1.1 400 ')).toBe(true);
      expect(reply.toLowerCase()).toContain('x-content-type-options: nosniff');
    }
    expect(reports).toHaveLength(1);
    // Closing reports what the window suppressed, so no error disappears silently.
    await server.close();
    expect(reports.length).toBe(2);
    expect(reports[1]?.message).toMatch(/\b99\b/);
  });
});
