/** Locks the page to its own origin: no inline script or style, no framing, no outside requests. */
export const CONTENT_SECURITY_POLICY: string = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers on the page and its assets. `no-store`: the HTML and asset URLs carry the token. */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};
