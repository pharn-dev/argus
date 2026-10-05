import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIPv4 } from 'node:net';

/** True for localhost, ::1 and 127.0.0.0/8; everything else (0.0.0.0, ::, names) is not loopback. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === 'localhost' || bare === '::1') {
    return true;
  }
  return isIPv4(bare) && bare.split('.')[0] === '127';
}

/** Constant-time token comparison over fixed-length digests, so length never leaks or throws. */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The Bearer token if present, else the `token` query parameter. */
export function presentedToken(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers.authorization;
  // Parsed without a regex: `/^bearer\s+(.+)$/` backtracks polynomially on long runs of spaces.
  if (header !== undefined && header.slice(0, 7).toLowerCase() === 'bearer ') {
    const token = header.slice(7).trim();
    if (token !== '') {
      return token;
    }
  }
  return url.searchParams.get('token') ?? undefined;
}
