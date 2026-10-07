import { renderPage } from './ui/page.js';
import { APP_SCRIPT } from './ui/app-script.js';
import { APP_STYLE } from './ui/app-style.js';

export type StaticAsset = { readonly contentType: string; readonly body: Buffer };

function asset(contentType: string, text: string): StaticAsset {
  return { contentType, body: Buffer.from(text, 'utf8') };
}

/**
 * The page and its two assets, keyed by pathname. None of them carries a credential: the browser
 * authenticates every request with the session cookie the `?token=` exchange set.
 */
export function createStaticAssets(): ReadonlyMap<string, StaticAsset> {
  return new Map<string, StaticAsset>([
    ['/', asset('text/html; charset=utf-8', renderPage())],
    ['/app.css', asset('text/css; charset=utf-8', APP_STYLE)],
    ['/app.js', asset('text/javascript; charset=utf-8', APP_SCRIPT)],
  ]);
}
