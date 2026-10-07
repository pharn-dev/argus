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

/** For responses that are never rendered as a document: allows nothing at all. */
export const NO_CONTENT_SECURITY_POLICY: string = "default-src 'none'; frame-ancestors 'none'";

/** Headers on the page and its assets. `no-store`: nothing the dashboard serves belongs in a cache. */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

/** Headers on the `/events` stream. */
export const EVENTS_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': NO_CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

/** Headers on every error, redirect and other plain response. */
export const ERROR_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': NO_CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};
