import { renderPage } from './ui/page.js';
import { APP_SCRIPT } from './ui/app-script.js';
import { APP_STYLE } from './ui/app-style.js';

export type StaticAsset = { readonly contentType: string; readonly body: Buffer };

function asset(contentType: string, text: string): StaticAsset {
  return { contentType, body: Buffer.from(text, 'utf8') };
}

/**
 * The page and its two assets, keyed by pathname. The token is fixed for the server's life, so the
 * page is rendered once, with the configured token (never a presented one) in its URLs.
 */
export function createStaticAssets(token: string | undefined): ReadonlyMap<string, StaticAsset> {
  const tokenQuery = token === undefined ? '' : `?token=${encodeURIComponent(token)}`;
  return new Map<string, StaticAsset>([
    ['/', asset('text/html; charset=utf-8', renderPage(tokenQuery))],
    ['/app.css', asset('text/css; charset=utf-8', APP_STYLE)],
    ['/app.js', asset('text/javascript; charset=utf-8', APP_SCRIPT)],
  ]);
}
