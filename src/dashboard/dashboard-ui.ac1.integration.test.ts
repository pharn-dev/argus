import { request, type IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';

type CollectorUnderTest = {
  readonly windows: { snapshot(): unknown[] };
  readonly alerts: { snapshot(): unknown[] };
};

type CollectorModule = {
  createCollector: (options: { windowMs: number; capacity: number }) => CollectorUnderTest;
};

type DashboardServerUnderTest = {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
};

type DashboardModule = {
  createDashboardServer: (options: {
    collector: CollectorUnderTest;
    host: string;
    port: number;
    token?: string;
  }) => Promise<DashboardServerUnderTest>;
};

type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };

type Tag = { name: string; attrs: Map<string, string> };

/** One GET over a fresh connection, with exactly the given request headers. */
function httpGet(url: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.setTimeout(5_000, () => req.destroy(new Error(`timed out: GET ${url}`)));
    req.end();
  });
}

/** A response header as one string ('' when absent). */
function header(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Every start tag of the HTML with its attributes (names lowercased, values unescaped). */
function parseTags(html: string): Tag[] {
  const tags: Tag[] = [];
  const tagPattern =
    /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  const attrPattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of html.matchAll(tagPattern)) {
    const attrs = new Map<string, string>();
    for (const attr of (match[2] ?? '').matchAll(attrPattern)) {
      const name = (attr[1] ?? '').toLowerCase();
      attrs.set(name, unescapeHtml(attr[2] ?? attr[3] ?? attr[4] ?? ''));
    }
    tags.push({ name: (match[1] ?? '').toLowerCase(), attrs });
  }
  return tags;
}

/** The `name=value` pairs of every set-cookie header, as a request `cookie` header value. */
function cookieHeader(headers: IncomingHttpHeaders): string {
  const setCookie = headers['set-cookie'] ?? [];
  return setCookie
    .map((cookie) => cookie.split(';')[0]?.trim() ?? '')
    .filter((pair) => pair !== '')
    .join('; ');
}

const REQUIRED_DIRECTIVES: readonly (readonly [string, string])[] = [
  ['default-src', "'none'"],
  ['script-src', "'self'"],
  ['style-src', "'self'"],
  ['connect-src', "'self'"],
  ['base-uri', "'none'"],
  ['form-action', "'none'"],
  ['frame-ancestors', "'none'"],
];

/** Asserts the response's content-security-policy holds every required directive and no unsafe source. */
function expectRestrictiveCsp(what: string, headers: IncomingHttpHeaders): void {
  const csp = header(headers, 'content-security-policy');
  expect(csp, `${what}: content-security-policy header`).not.toBe('');
  expect(csp.toLowerCase(), `${what}: no 'unsafe-inline'`).not.toContain("'unsafe-inline'");
  expect(csp.toLowerCase(), `${what}: no 'unsafe-eval'`).not.toContain("'unsafe-eval'");
  const directives = new Map<string, string[]>();
  for (const part of csp.split(/[;,]/)) {
    const tokens = part
      .trim()
      .split(/\s+/)
      .filter((token) => token !== '');
    const name = tokens[0]?.toLowerCase();
    if (name !== undefined && !directives.has(name)) {
      directives.set(
        name,
        tokens.slice(1).map((token) => token.toLowerCase()),
      );
    }
  }
  for (const [name, source] of REQUIRED_DIRECTIVES) {
    const sources = directives.get(name);
    expect(sources, `${what}: directive ${name}`).toBeDefined();
    if (source === "'none'") {
      expect(sources, `${what}: ${name} ${source}`).toEqual(["'none'"]);
    } else {
      expect(sources, `${what}: ${name} ${source}`).toContain(source);
    }
  }
}

describe('dashboard UI — AC-1', () => {
  it('AC-1: GET /?token=s3cret leads, via the session cookie, to an HTML page whose same-origin script and stylesheet load like a browser would, all under a restrictive CSP', async () => {
    const collectorModule = (await import('../collector/index.js')) as unknown as CollectorModule;
    const dashboardModule = (await import('./index.js')) as unknown as DashboardModule;

    const collector = collectorModule.createCollector({ windowMs: 1000, capacity: 50 });
    let server: DashboardServerUnderTest | undefined;
    try {
      server = await dashboardModule.createDashboardServer({
        collector,
        host: '127.0.0.1',
        port: 0,
        token: 's3cret',
      });
      const loginUrl = `http://127.0.0.1:${server.port}/?token=s3cret`;
      const pageUrl = `http://127.0.0.1:${server.port}/`;
      const pageOrigin = new URL(pageUrl).origin;

      // The token exchange: a redirect to the clean page URL, carrying the session cookie.
      const login = await httpGet(loginUrl);
      expect(login.status, 'GET /?token=s3cret').toBe(303);
      expect(new URL(header(login.headers, 'location'), loginUrl).href).toBe(pageUrl);
      const cookie = cookieHeader(login.headers);
      expect(cookie, 'the session cookie').not.toBe('');

      // The page, requested the way the browser follows the redirect.
      const page = await httpGet(pageUrl, { cookie });
      expect(page.status).toBe(200);
      expect(header(page.headers, 'content-type')).toMatch(/^text\/html/);
      expectRestrictiveCsp('GET /', page.headers);

      const tags = parseTags(page.body);

      // No inline script content and no inline event-handler attribute.
      for (const match of page.body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)) {
        expect((match[1] ?? '').trim(), 'inline script content').toBe('');
      }
      const scriptTags = tags.filter((tag) => tag.name === 'script');
      for (const tag of scriptTags) {
        expect(tag.attrs.get('src') ?? '', 'every script element has a src').not.toBe('');
      }
      const handlerAttrs = tags.flatMap((tag) =>
        [...tag.attrs.keys()].filter((name) => /^on[a-z]/.test(name)),
      );
      expect(handlerAttrs, 'inline event-handler attributes').toEqual([]);

      // At least one same-origin script and one same-origin stylesheet.
      const scriptUrls = scriptTags.map((tag) => new URL(tag.attrs.get('src') ?? '', pageUrl));
      const styleUrls = tags
        .filter(
          (tag) =>
            tag.name === 'link' &&
            (tag.attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet') &&
            (tag.attrs.get('href') ?? '') !== '',
        )
        .map((tag) => new URL(tag.attrs.get('href') ?? '', pageUrl));
      expect(scriptUrls.length, 'referenced scripts').toBeGreaterThanOrEqual(1);
      expect(styleUrls.length, 'referenced stylesheets').toBeGreaterThanOrEqual(1);
      for (const url of [...scriptUrls, ...styleUrls]) {
        expect(url.origin, `${url.href} is same-origin`).toBe(pageOrigin);
      }

      // Every referenced asset, requested the way a browser would: the session cookie, no Authorization.
      const assetHeaders: Record<string, string> = { cookie };
      for (const url of scriptUrls) {
        const asset = await httpGet(url.href, assetHeaders);
        expect(asset.status, `GET ${url.pathname}`).toBe(200);
        expect(header(asset.headers, 'content-type'), `GET ${url.pathname}`).toMatch(
          /^(text|application)\/javascript/,
        );
        expectRestrictiveCsp(`GET ${url.pathname}`, asset.headers);
      }
      for (const url of styleUrls) {
        const asset = await httpGet(url.href, assetHeaders);
        expect(asset.status, `GET ${url.pathname}`).toBe(200);
        expect(header(asset.headers, 'content-type'), `GET ${url.pathname}`).toMatch(/^text\/css/);
        expectRestrictiveCsp(`GET ${url.pathname}`, asset.headers);
      }
    } finally {
      await server?.close();
    }
  }, 20_000);
});
