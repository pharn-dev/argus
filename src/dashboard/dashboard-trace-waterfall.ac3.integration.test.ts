import { request, type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type SpanRecord = {
  type: 'span';
  traceId: string;
  spanId: string;
  name: string;
  method: string;
  path: string;
  statusCode: number;
  startTimeMs: number;
  durationNs: number;
};

type CollectorUnderTest = {
  readonly windows: { snapshot(): unknown[] };
  readonly alerts: { snapshot(): unknown[] };
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
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

/** The slice of happy-dom's API this test drives (typed locally: the module loads inside the test body). */
type DomAttr = { readonly name: string; readonly value: string };

type DomElement = {
  readonly tagName: string;
  textContent: string | null;
  readonly parentElement: DomElement | null;
  readonly attributes: ArrayLike<DomAttr>;
  getAttribute(name: string): string | null;
  closest(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  appendChild(child: DomElement): unknown;
};

type DomDocument = {
  write(html: string): void;
  createElement(tagName: string): DomElement;
  readonly head: DomElement | null;
  readonly body: DomElement | null;
  getElementById(id: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  cookie: string;
};

type DomWindow = {
  readonly document: DomDocument;
  readonly happyDOM: { close(): Promise<void> };
};

type HappyDomModule = {
  Window: new (options: { url: string; settings: Record<string, boolean> }) => DomWindow;
};

type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };

/** The CSP the dashboard served for the page before this feature, byte for byte. */
const EXPECTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const HEADINGS = 'h1, h2, h3, h4, h5, h6';

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

/** Exchanges `?token=` for the session cookie: the Set-Cookie line and the request Cookie value. */
async function login(base: string, token: string): Promise<{ setCookie: string; cookie: string }> {
  const response = await httpGet(`${base}/?token=${encodeURIComponent(token)}`);
  expect(response.status, 'GET /?token=…').toBe(303);
  const setCookie = response.headers['set-cookie']?.[0] ?? '';
  expect(setCookie, 'the session cookie').not.toBe('');
  return { setCookie, cookie: setCookie.split(';')[0] ?? '' };
}

/** A response header as one string ('' when absent). */
function header(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

/** Polls the predicate until it holds, or fails after the timeout. */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function newWindow(happyDom: HappyDomModule, url: string, runScripts: boolean): DomWindow {
  // happy-dom's own file loading is off: the test fetches the assets itself and decides what runs.
  return new happyDom.Window({
    url,
    settings: {
      enableJavaScriptEvaluation: runScripts,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
}

/** Elements named as the trace waterfall: an aria-label, or a heading text, holding the name. */
function waterfallElements(document: DomDocument): DomElement[] {
  const named = (text: string): boolean => {
    const lowered = text.toLowerCase();
    return lowered.includes('waterfall') || lowered.includes('recent requests');
  };
  const byLabel = Array.from(document.querySelectorAll('[aria-label]')).filter((element) =>
    named(element.getAttribute('aria-label') ?? ''),
  );
  const byHeading = Array.from(document.querySelectorAll(HEADINGS)).filter((element) =>
    named(element.textContent ?? ''),
  );
  return [...byLabel, ...byHeading];
}

/** The text of every region named as the waterfall (the labelled element, or the section a heading leads). */
function waterfallText(document: DomDocument): string {
  return waterfallElements(document)
    .map((element) =>
      HEADINGS.split(', ').includes(element.tagName.toLowerCase())
        ? (element.closest('section') ?? element.parentElement ?? element).textContent
        : element.textContent,
    )
    .join('\n');
}

const failingSpan: SpanRecord = {
  type: 'span',
  traceId: '0a'.repeat(16),
  spanId: '0b'.repeat(8),
  name: 'GET /checkout-slow',
  method: 'GET',
  path: '/checkout-slow',
  statusCode: 503,
  startTimeMs: 1_700_000_000_000,
  durationNs: 42_500_000,
};

describe('dashboard trace waterfall — AC-3', () => {
  it('AC-3: the page names a trace waterfall, holds no inline script or style, keeps the exact pre-feature CSP, and its served script handles span events', async () => {
    const collectorModule = (await import('../collector/index.js')) as unknown as CollectorModule;
    const dashboardModule = (await import('./index.js')) as unknown as DashboardModule;
    const happyDom = (await import('happy-dom')) as unknown as HappyDomModule;

    const collector = collectorModule.createCollector({ windowMs: 1000, capacity: 50 });
    // A span recorded before the page loads; the server replays it to every new SSE connection.
    await collector.consume(Readable.from([failingSpan]));

    let server: DashboardServerUnderTest | undefined;
    const windows: DomWindow[] = [];
    try {
      server = await dashboardModule.createDashboardServer({
        collector,
        host: '127.0.0.1',
        port: 0,
        token: 's3cret',
      });
      const base = `http://127.0.0.1:${server.port}`;
      const pageUrl = `${base}/`;
      const { setCookie, cookie } = await login(base, 's3cret');

      // The page: 200, and the CSP header byte-identical to the pre-feature one.
      const page = await httpGet(pageUrl, { cookie });
      expect(page.status, 'GET / with the session cookie').toBe(200);
      expect(header(page.headers, 'content-security-policy')).toBe(EXPECTED_CSP);

      // The page parsed as a document, with no script run.
      const staticWindow = newWindow(happyDom, pageUrl, false);
      windows.push(staticWindow);
      const staticDocument = staticWindow.document;
      staticDocument.write(page.body);

      // An element named as the trace waterfall.
      expect(
        waterfallElements(staticDocument).length,
        'an element named "waterfall" or "Recent requests"',
      ).toBeGreaterThanOrEqual(1);

      // No inline script or style: every script has a src and no content, no <style>, no style= or on*=.
      const scripts = Array.from(staticDocument.querySelectorAll('script'));
      expect(scripts.length, 'script elements').toBeGreaterThanOrEqual(1);
      for (const script of scripts) {
        expect(script.getAttribute('src') ?? '', 'every script element has a src').not.toBe('');
        expect((script.textContent ?? '').trim(), 'inline script content').toBe('');
      }
      expect(staticDocument.querySelectorAll('style').length, '<style> elements').toBe(0);
      const inlineAttrs = Array.from(staticDocument.querySelectorAll('*')).flatMap((element) =>
        Array.from(element.attributes)
          .map((attr) => attr.name.toLowerCase())
          .filter((name) => name === 'style' || name.startsWith('on'))
          .map((name) => `${element.tagName.toLowerCase()}[${name}]`),
      );
      expect(inlineAttrs, 'inline style or event-handler attributes').toEqual([]);

      // The referenced script and stylesheet assets.
      const scriptUrls = scripts.map(
        (script) => new URL(script.getAttribute('src') ?? '', pageUrl),
      );
      const styleUrls = Array.from(staticDocument.querySelectorAll('link'))
        .filter(
          (link) =>
            (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet') &&
            (link.getAttribute('href') ?? '') !== '',
        )
        .map((link) => new URL(link.getAttribute('href') ?? '', pageUrl));
      expect(styleUrls.length, 'referenced stylesheets').toBeGreaterThanOrEqual(1);

      const styleBodies: string[] = [];
      for (const url of styleUrls) {
        const asset = await httpGet(url.href, { cookie });
        expect(asset.status, `GET ${url.pathname}`).toBe(200);
        expect(header(asset.headers, 'content-security-policy'), `GET ${url.pathname}`).toBe(
          EXPECTED_CSP,
        );
        styleBodies.push(asset.body);
      }
      const scriptBodies: string[] = [];
      for (const url of scriptUrls) {
        const asset = await httpGet(url.href, { cookie });
        expect(asset.status, `GET ${url.pathname}`).toBe(200);
        expect(header(asset.headers, 'content-security-policy'), `GET ${url.pathname}`).toBe(
          EXPECTED_CSP,
        );
        scriptBodies.push(asset.body);
      }

      // The served script dispatches on the `span` event name.
      const servedScript = scriptBodies.join('\n');
      expect(
        servedScript.includes("'span'") || servedScript.includes('"span"'),
        "the served script names the 'span' event",
      ).toBe(true);

      // And it handles one: run in a DOM, the replayed span shows up in the waterfall.
      const liveWindow = newWindow(happyDom, pageUrl, true);
      windows.push(liveWindow);
      const liveDocument = liveWindow.document;
      // The browser's cookie jar after the exchange: the script's same-origin fetch sends it.
      liveDocument.cookie = setCookie;
      liveDocument.write(page.body);
      for (const css of styleBodies) {
        const style = liveDocument.createElement('style');
        style.textContent = css;
        (liveDocument.head ?? liveDocument.body)?.appendChild(style);
      }
      for (const js of scriptBodies) {
        const script = liveDocument.createElement('script');
        script.textContent = js;
        liveDocument.body?.appendChild(script);
      }
      await waitFor(
        () => {
          const text = waterfallText(liveDocument);
          return text.includes(failingSpan.path) && text.includes(String(failingSpan.statusCode));
        },
        10_000,
        'the replayed span in the waterfall',
      );
      const shown = waterfallText(liveDocument);
      expect(shown).toContain(failingSpan.method);
      expect(shown).toContain(failingSpan.path);
      expect(shown).toContain(String(failingSpan.statusCode));
    } finally {
      // The windows first: closing them cancels the script's fetch and any reconnect timer.
      for (const window of windows) {
        await window.happyDOM.close();
      }
      await server?.close();
    }
  }, 30_000);
});
