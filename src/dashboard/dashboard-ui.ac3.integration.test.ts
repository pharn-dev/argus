import { request, type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

type AlertRuleInput = {
  id: string;
  metric: string;
  comparison: string;
  threshold: number;
};

type CollectorUnderTest = {
  readonly windows: { snapshot(): unknown[] };
  readonly alerts: { snapshot(): unknown[] };
  consume(source: Readable | AsyncIterable<unknown>): Promise<void>;
};

type CollectorModule = {
  createCollector: (options: {
    windowMs: number;
    capacity: number;
    alerts?: readonly AlertRuleInput[];
  }) => CollectorUnderTest;
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
type DomElement = {
  readonly tagName: string;
  textContent: string | null;
  readonly parentElement: DomElement | null;
  closest(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  appendChild(child: DomElement): unknown;
};

type DomDocument = {
  write(html: string): void;
  createElement(tagName: string): DomElement;
  readonly head: DomElement | null;
  readonly body: DomElement | null;
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

/** Exchanges `?token=` for the session cookie: the Set-Cookie line and the request Cookie value. */
async function login(base: string, token: string): Promise<{ setCookie: string; cookie: string }> {
  const response = await httpGet(`${base}/?token=${encodeURIComponent(token)}`);
  expect(response.status, 'GET /?token=…').toBe(303);
  const setCookie = response.headers['set-cookie']?.[0] ?? '';
  expect(setCookie, 'the session cookie').not.toBe('');
  return { setCookie, cookie: setCookie.split(';')[0] ?? '' };
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

/** A full AgentSample-shaped object with the given p99 lag (ns), heap used (bytes) and GC count. */
function makeSample(
  timestamp: number,
  p99: number,
  heapUsed: number,
  gcCount: number,
): Record<string, unknown> {
  return {
    timestamp,
    eventLoop: { min: 1_000_000, max: p99, mean: 1_000_000, p50: 1_000_000, p99 },
    memory: {
      heapUsed,
      heapTotal: 209_715_200,
      rss: 314_572_800,
      external: 0,
      arrayBuffers: 0,
    },
    gc: {
      count: gcCount,
      totalPause: 0,
      maxPause: 0,
      kinds: { minor: gcCount, major: 0, incremental: 0, weakcb: 0 },
    },
    backpressure: { events: 0, totalStall: 0, maxStall: 0, hotspots: [] },
  };
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

const HEADINGS = 'h1, h2, h3, h4, h5, h6';

/** The section a heading with exactly this text leads (undefined when no such heading). */
function sectionOf(document: DomDocument, heading: string): DomElement | undefined {
  const match = Array.from(document.querySelectorAll(HEADINGS)).find(
    (element) => (element.textContent ?? '').trim() === heading,
  );
  if (match === undefined) {
    return undefined;
  }
  return match.closest('section') ?? match.parentElement ?? undefined;
}

/** The text of the section headed `heading`, without the heading's own text ('' when absent). */
function sectionText(document: DomDocument, heading: string): string {
  const section = sectionOf(document, heading);
  if (section === undefined) {
    return '';
  }
  const headingTexts = Array.from(section.querySelectorAll(HEADINGS)).map(
    (element) => element.textContent ?? '',
  );
  let text = section.textContent ?? '';
  for (const headingText of headingTexts) {
    text = text.replace(headingText, '');
  }
  return text;
}

/** The texts of the list items in the section headed `Alerts`. */
function alertItems(document: DomDocument): string[] {
  const section = sectionOf(document, 'Alerts');
  if (section === undefined) {
    return [];
  }
  return Array.from(section.querySelectorAll('li')).map((item) => item.textContent ?? '');
}

function hasLagHighFiring(document: DomDocument): boolean {
  return alertItems(document).some((text) => text.includes('lag-high') && text.includes('firing'));
}

function hasLagHigh(document: DomDocument): boolean {
  return alertItems(document).some((text) => text.includes('lag-high'));
}

const rules: AlertRuleInput[] = [
  { id: 'lag-high', metric: 'eventLoop.p99', comparison: '>', threshold: 10_000_000 },
];

describe('dashboard UI — AC-3', () => {
  it('AC-3: the served page, run in a DOM, shows the newest window and the recent alerts, then updates live on a new window', async () => {
    const collectorModule = (await import('../collector/index.js')) as unknown as CollectorModule;
    const dashboardModule = (await import('./index.js')) as unknown as DashboardModule;
    const happyDom = (await import('happy-dom')) as unknown as HappyDomModule;

    // Given: W1 (12 ms p99, 50 MiB heap, 7 GCs) has fired lag-high before the page loads.
    const collector = collectorModule.createCollector({
      windowMs: 1000,
      capacity: 50,
      alerts: rules,
    });
    await collector.consume(Readable.from([makeSample(100, 12_000_000, 52_428_800, 7)]));
    expect(collector.windows.snapshot()).toHaveLength(1);
    expect(collector.alerts.snapshot()).toEqual([
      expect.objectContaining({ ruleId: 'lag-high', state: 'firing' }),
    ]);

    let server: DashboardServerUnderTest | undefined;
    let window: DomWindow | undefined;
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

      const page = await httpGet(pageUrl, { cookie });
      expect(page.status, 'GET / with the session cookie').toBe(200);
      const tags = parseTags(page.body);
      const scriptUrls = tags
        .filter((tag) => tag.name === 'script' && (tag.attrs.get('src') ?? '') !== '')
        .map((tag) => new URL(tag.attrs.get('src') ?? '', pageUrl));
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

      const styles: string[] = [];
      for (const url of styleUrls) {
        const response = await httpGet(url.href, { cookie });
        expect(response.status, `GET ${url.pathname}`).toBe(200);
        styles.push(response.body);
      }
      const scripts: string[] = [];
      for (const url of scriptUrls) {
        const response = await httpGet(url.href, { cookie });
        expect(response.status, `GET ${url.pathname}`).toBe(200);
        scripts.push(response.body);
      }

      // The page in a DOM window at the page URL; happy-dom's own file loading is off, so the
      // stylesheet and script fetched above are the ones applied and executed, in document order.
      window = new happyDom.Window({
        url: pageUrl,
        settings: {
          enableJavaScriptEvaluation: true,
          suppressInsecureJavaScriptEnvironmentWarning: true,
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      });
      const document = window.document;
      // The browser's cookie jar after the exchange: the script's same-origin fetch sends it.
      document.cookie = setCookie;
      document.write(page.body);
      for (const css of styles) {
        const style = document.createElement('style');
        style.textContent = css;
        (document.head ?? document.body)?.appendChild(style);
      }
      for (const js of scripts) {
        const script = document.createElement('script');
        script.textContent = js;
        document.body?.appendChild(script);
      }

      // Then, before W2: the replayed W1 figures and the firing alert.
      await waitFor(
        () => {
          const lag = sectionText(document, 'Event loop lag');
          return (
            lag.includes('12') &&
            lag.includes('ms') &&
            sectionText(document, 'Memory').includes('50') &&
            sectionText(document, 'GC').includes('7') &&
            hasLagHighFiring(document)
          );
        },
        10_000,
        'the W1 figures and the lag-high alert on the page',
      );
      const lagBefore = sectionText(document, 'Event loop lag');
      expect(lagBefore).toContain('12');
      expect(lagBefore).toContain('ms');
      expect(sectionText(document, 'Memory')).toContain('50');
      expect(sectionText(document, 'GC')).toContain('7');
      expect(hasLagHighFiring(document)).toBe(true);

      // When: the collector produces W2 (34 ms p99, 100 MiB heap, 9 GCs) after the script connected.
      await collector.consume(Readable.from([makeSample(1100, 34_000_000, 104_857_600, 9)]));
      expect(collector.windows.snapshot()).toHaveLength(2);

      // Then: the figures update live, and lag-high is still listed.
      await waitFor(
        () => {
          const lag = sectionText(document, 'Event loop lag');
          return (
            lag.includes('34') &&
            lag.includes('ms') &&
            sectionText(document, 'Memory').includes('100') &&
            sectionText(document, 'GC').includes('9') &&
            hasLagHigh(document)
          );
        },
        10_000,
        'the W2 figures on the page',
      );
      const lagAfter = sectionText(document, 'Event loop lag');
      expect(lagAfter).toContain('34');
      expect(lagAfter).toContain('ms');
      expect(sectionText(document, 'Memory')).toContain('100');
      expect(sectionText(document, 'GC')).toContain('9');
      expect(hasLagHigh(document)).toBe(true);
    } finally {
      // The window first: closing it cancels the script's fetch and any reconnect timer.
      await window?.happyDOM.close();
      await server?.close();
    }
  }, 30_000);
});
