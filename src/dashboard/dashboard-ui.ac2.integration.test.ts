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

describe('dashboard UI — AC-2', () => {
  it('AC-2: the page and every asset it references answer 401 with no page or asset content for missing or wrong credentials, and 200 with Bearer s3cret', async () => {
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
      const base = `http://127.0.0.1:${server.port}`;
      const pageUrl = `${base}/?token=s3cret`;

      // Given: the asset paths the authorized page references, and the authorized bodies.
      const page = await httpGet(pageUrl);
      expect(page.status, 'GET /?token=s3cret').toBe(200);
      const tags = parseTags(page.body);
      const assetUrls = [
        ...tags
          .filter((tag) => tag.name === 'script' && (tag.attrs.get('src') ?? '') !== '')
          .map((tag) => new URL(tag.attrs.get('src') ?? '', pageUrl)),
        ...tags
          .filter(
            (tag) =>
              tag.name === 'link' &&
              (tag.attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet') &&
              (tag.attrs.get('href') ?? '') !== '',
          )
          .map((tag) => new URL(tag.attrs.get('href') ?? '', pageUrl)),
      ];
      expect(assetUrls.length, 'assets the authorized page references').toBeGreaterThanOrEqual(1);

      const authorizedBodies: string[] = [page.body];
      for (const url of assetUrls) {
        const asset = await httpGet(url.href);
        expect(asset.status, `authorized GET ${url.pathname}${url.search}`).toBe(200);
        authorizedBodies.push(asset.body);
      }

      const paths = ['/', ...new Set(assetUrls.map((url) => url.pathname))];
      expect(paths.length).toBeGreaterThanOrEqual(2);

      // When: no credentials, a wrong Bearer token, a wrong ?token=.
      const attempts: { label: string; url: string; headers: Record<string, string> }[] = [];
      for (const path of paths) {
        attempts.push({
          label: `GET ${path} (no credentials)`,
          url: `${base}${path}`,
          headers: {},
        });
        attempts.push({
          label: `GET ${path} (Bearer wrong)`,
          url: `${base}${path}`,
          headers: { authorization: 'Bearer wrong' },
        });
        attempts.push({
          label: `GET ${path}?token=wrong`,
          url: `${base}${path}?token=wrong`,
          headers: {},
        });
      }
      for (const attempt of attempts) {
        const response = await httpGet(attempt.url, attempt.headers);
        expect(response.status, attempt.label).toBe(401);
        const lowered = response.body.toLowerCase();
        expect(lowered, `${attempt.label}: body has no <html`).not.toContain('<html');
        expect(lowered, `${attempt.label}: body has no <script`).not.toContain('<script');
        expect(lowered, `${attempt.label}: body has no <link`).not.toContain('<link');
        for (const authorized of authorizedBodies) {
          if (authorized.trim() !== '') {
            expect(
              response.body.includes(authorized),
              `${attempt.label}: body holds an authorized page or asset body`,
            ).toBe(false);
          }
        }
      }

      // When: the right Bearer token, no query.
      for (const path of paths) {
        const response = await httpGet(`${base}${path}`, { authorization: 'Bearer s3cret' });
        expect(response.status, `GET ${path} (Bearer s3cret)`).toBe(200);
      }
    } finally {
      await server?.close();
    }
  }, 20_000);
});
