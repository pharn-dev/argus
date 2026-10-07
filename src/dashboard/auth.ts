import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIPv4 } from 'node:net';

/** The cookie the `?token=` exchange sets. Its value is an HMAC of the token, never the token. */
export const SESSION_COOKIE = 'argus_token';

function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** True for localhost, ::1 and 127.0.0.0/8; everything else (0.0.0.0, ::, names) is not loopback. */
export function isLoopbackHost(host: string): boolean {
  const bare = unbracket(host);
  if (bare === 'localhost' || bare === '::1') {
    return true;
  }
  return isIPv4(bare) && bare.split('.')[0] === '127';
}

/** True for the any-address binds (0.0.0.0 and ::), which also listen on loopback. */
function isWildcardHost(host: string): boolean {
  const bare = unbracket(host);
  return bare === '0.0.0.0' || bare === '::';
}

/** Constant-time token comparison over fixed-length digests, so length never leaks or throws. */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The Bearer token of the Authorization header, if any. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  // Parsed without a regex: `/^bearer\s+(.+)$/` backtracks polynomially on long runs of spaces.
  if (header !== undefined && header.slice(0, 7).toLowerCase() === 'bearer ') {
    const token = header.slice(7).trim();
    if (token !== '') {
      return token;
    }
  }
  return undefined;
}

/** Every value of the named cookie in the request's Cookie header (a name may repeat). */
export function cookieValues(req: IncomingMessage, name: string): string[] {
  const header = req.headers.cookie;
  if (header === undefined) {
    return [];
  }
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      values.push(part.slice(eq + 1).trim());
    }
  }
  return values;
}

/**
 * The opaque cookie value for a token: an HMAC under a key drawn once per server, so the cookie
 * proves its holder presented the token without revealing it, and dies with the server.
 */
export function sessionValueFor(token: string): string {
  return createHmac('sha256', randomBytes(32)).update(token).digest('base64url');
}

/** A `host[:port]` authority, lowercased; `hostname` keeps the brackets of an IPv6 literal. */
export type Authority = { readonly hostname: string; readonly port: number | undefined };

/** Parses a Host header (or an `allowedHosts` entry); `undefined` when it is not a valid authority. */
export function parseAuthority(value: string): Authority | undefined {
  const text = value.trim().toLowerCase();
  if (text === '' || /[\s/?#@\\]/.test(text)) {
    return undefined;
  }
  let hostname: string;
  let rest: string;
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end === -1) {
      return undefined;
    }
    hostname = text.slice(0, end + 1);
    rest = text.slice(end + 1);
  } else {
    const colon = text.indexOf(':');
    if (colon === -1) {
      hostname = text;
      rest = '';
    } else if (text.includes(':', colon + 1)) {
      // A bare IPv6 literal (only meaningful in configuration): bracket it, no port.
      return { hostname: `[${text}]`, port: undefined };
    } else {
      hostname = text.slice(0, colon);
      rest = text.slice(colon);
    }
  }
  if (hostname === '' || hostname === '[]') {
    return undefined;
  }
  if (rest === '') {
    return { hostname, port: undefined };
  }
  if (!/^:[0-9]{1,5}$/.test(rest)) {
    return undefined;
  }
  const port = Number(rest.slice(1));
  return port <= 65535 ? { hostname, port } : undefined;
}

/** Decides which `Host` and `Origin` values the dashboard answers. */
export type HostPolicy = {
  hostAllowed(hostHeader: string | undefined): boolean;
  originAllowed(origin: string): boolean;
};

/**
 * Allows the bind address on the bound port, plus `localhost`, `127.0.0.1` and `[::1]` on that port
 * when the bind listens on loopback (a loopback or an any-address bind). Each `allowedHosts` entry
 * adds a hostname on any port, or, written `host:port`, exactly that authority. A request naming
 * any other host is refused, which is what defeats DNS rebinding: the attacker's page can point
 * its own hostname at the dashboard's address, but the browser still sends that hostname.
 */
export function createHostPolicy(
  bindHost: string,
  port: number,
  allowedHosts: readonly string[],
): HostPolicy {
  const defaultNames = new Set<string>();
  const bind = parseAuthority(
    bindHost.includes(':') && !bindHost.startsWith('[') ? `[${bindHost}]` : bindHost,
  );
  if (bind !== undefined) {
    defaultNames.add(bind.hostname);
  }
  if (isLoopbackHost(bindHost) || isWildcardHost(bindHost)) {
    defaultNames.add('localhost');
    defaultNames.add('127.0.0.1');
    defaultNames.add('[::1]');
  }
  const anyPort = new Set<string>();
  const exact = new Set<string>();
  for (const entry of allowedHosts) {
    const parsed = typeof entry === 'string' ? parseAuthority(entry) : undefined;
    if (parsed === undefined) {
      throw new RangeError(`allowedHosts entry ${JSON.stringify(entry)} is not a valid host`);
    }
    if (parsed.port === undefined) {
      anyPort.add(parsed.hostname);
    } else {
      exact.add(`${parsed.hostname}:${parsed.port}`);
    }
  }

  const allowed = (authority: Authority, defaultPort: number): boolean => {
    const effectivePort = authority.port ?? defaultPort;
    return (
      (defaultNames.has(authority.hostname) && effectivePort === port) ||
      anyPort.has(authority.hostname) ||
      exact.has(`${authority.hostname}:${effectivePort}`)
    );
  };

  return {
    hostAllowed(hostHeader: string | undefined): boolean {
      if (hostHeader === undefined) {
        return false;
      }
      const authority = parseAuthority(hostHeader);
      return authority !== undefined && allowed(authority, 80);
    },
    originAllowed(origin: string): boolean {
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        // `null` (an opaque origin) or garbage: never one of ours.
        return false;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return false;
      }
      if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '') {
        return false;
      }
      const authority = parseAuthority(url.host);
      return authority !== undefined && allowed(authority, url.protocol === 'https:' ? 443 : 80);
    },
  };
}
