/// <reference types="node" />
import { OutgoingMessage } from 'node:http';
import { Duplex, Writable } from 'node:stream';
import { isExcludedFromBackpressure } from './backpressure-exclusion.js';
import { siteFromStack } from './stack-site.js';

/** One call site that stalled. Stall times are integer nanoseconds. */
export type BackpressureHotspot = {
  site: string;
  events: number;
  totalStall: number;
  maxStall: number;
};

/** One window of backpressure activity. Stall times are integer nanoseconds, the rest integer counts. */
export type BackpressureSample = {
  events: number;
  totalStall: number;
  maxStall: number;
  hotspots: BackpressureHotspot[];
};

export type BackpressureProbeOptions = {
  /** Maximum hotspots per sample. Defaults to 10. */
  maxHotspots?: number;
};

export type BackpressureProbe = {
  enable(): void;
  disable(): void;
  /** Read the current window, then reset so the next window starts fresh. */
  sample(): BackpressureSample;
};

const DEFAULT_MAX_HOTSPOTS = 10;
const MAX_SITES_PER_WINDOW = 256;
const OTHER_SITE = '<other>';
const STACK_LIMIT = 32;

type SiteStats = { events: number; totalStall: number; maxStall: number };
type Window = {
  events: number;
  totalStall: number;
  maxStall: number;
  sites: Map<string, SiteStats>;
};
type OpenStall = { start: bigint; site: string };

function toNonNegativeInt(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  const rounded = Math.round(value);
  if (rounded < 0) {
    return 0;
  }
  return rounded > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : rounded;
}

function saturatingAdd(a: number, b: number): number {
  return Math.min(a + b, Number.MAX_SAFE_INTEGER);
}

function emptyWindow(): Window {
  return { events: 0, totalStall: 0, maxStall: 0, sites: new Map() };
}

// ---- Shared prototype wrap -------------------------------------------------------------------
//
// `write()` is patched on three prototypes, because Node copies the Writable methods onto
// `Duplex.prototype` at bootstrap and `http.OutgoingMessage` has its own `write`:
//   - `Writable.prototype`        → Writable subclasses, `fs.WriteStream`
//   - `Duplex.prototype`          → `net.Socket`, `tls.TLSSocket`, `Duplex`, `Transform`, `PassThrough`
//   - `OutgoingMessage.prototype` → `http.ServerResponse`, `http.ClientRequest`
//
// Safety rules (the wrappers run inside every write of the host):
//   - A wrapper never throws into the host: observers run under try/catch and failures are reported.
//   - Each install captures its originals in a per-install record. Uninstalling marks the record
//     inactive, which turns its wrapper into a transparent pass-through to the original it captured,
//     so a third-party wrapper stacked on top keeps working.
//   - A prototype is restored only while it still holds our wrapper (identity guard); a wrapper
//     someone installed later is never removed.
//   - The observer set and the active install live on `globalThis` under a `Symbol.for` key, with the
//     same lifetime as the prototypes they patch. A second copy of Argus (ESM + CJS) joins the
//     existing install instead of wrapping again, and the last probe disabled in either copy
//     restores the prototypes.

/** The stream whose `write()` returned false: a Writable, a Duplex or an `http.OutgoingMessage`. */
type Observable = NodeJS.EventEmitter;
type WriteFn = (this: unknown, ...args: unknown[]) => unknown;
/** Shared by every Argus copy that uses the v1 registry; change `REGISTRY_KEY` if it changes. */
type Observer = (stream: Observable, wrapper: WriteFn) => void;
type Patch = {
  readonly target: { write?: unknown };
  readonly hadOwn: boolean;
  readonly original: WriteFn;
  wrapper: WriteFn | undefined;
  active: boolean;
};
type Session = { readonly patches: Patch[]; suppress: number };
type Registry = { readonly observers: Set<Observer>; session: Session | undefined };

const REGISTRY_KEY = Symbol.for('argus.backpressure.v1');
/** Set on every wrapper; points at its install record so a later install can skip a dead layer. */
const WRAPPER_KEY = Symbol.for('argus.backpressure.write');
const MAX_PEEL = 64;

function isRegistry(value: unknown): value is Registry {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { observers?: unknown }).observers instanceof Set &&
    'session' in value
  );
}

function sharedRegistry(): Registry {
  const host = globalThis as unknown as Record<symbol, unknown>;
  const existing = host[REGISTRY_KEY];
  if (isRegistry(existing)) {
    return existing;
  }
  const created: Registry = { observers: new Set(), session: undefined };
  if (existing === undefined) {
    Object.defineProperty(host, REGISTRY_KEY, { value: created, configurable: true });
  }
  return created;
}

const registry = sharedRegistry();
const siteCache = new WeakMap<object, string>();
const reported = new Set<string>();

/** Report a probe failure once per kind, as a process warning. */
function report(kind: string, error: unknown): void {
  if (reported.has(kind)) {
    return;
  }
  reported.add(kind);
  const message = error instanceof Error ? error.message : String(error);
  process.emitWarning(
    `backpressure probe ${kind} failed: ${message} (further ${kind} failures are not reported)`,
    'ArgusBackpressureWarning',
  );
}

/** This module's own file as it appears in stacks, found once at load (works under ESM and CJS). */
const ownFiles: ReadonlySet<string> = (() => {
  const site = siteFromStack(new Error('probe').stack ?? '', new Set());
  if (site === undefined) {
    return new Set<string>();
  }
  return new Set<string>([site.slice(0, site.lastIndexOf(':'))]);
})();

function fallbackSite(stream: Observable): string {
  const name = stream.constructor.name;
  return name === '' ? 'Writable' : name;
}

/** Capture the call site of a stream's first stall. Runs once per stream. */
function siteOf(stream: Observable, wrapper: WriteFn): string {
  const cached = siteCache.get(stream);
  if (cached !== undefined) {
    return cached;
  }
  let site: string | undefined;
  const previousLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = STACK_LIMIT;
    const holder: { stack?: string } = {};
    Error.captureStackTrace(holder, wrapper);
    site = siteFromStack(holder.stack ?? '', ownFiles);
  } catch {
    // Capturing a stack is best effort; the constructor name below still identifies the stream.
    site = undefined;
  } finally {
    Error.stackTraceLimit = previousLimit;
  }
  const resolved = site ?? fallbackSite(stream);
  siteCache.set(stream, resolved);
  return resolved;
}

function notify(stream: unknown, wrapper: WriteFn): void {
  if (typeof stream !== 'object' || stream === null || registry.observers.size === 0) {
    return;
  }
  if (isExcludedFromBackpressure(stream)) {
    return;
  }
  for (const observer of registry.observers) {
    try {
      observer(stream as Observable, wrapper);
    } catch (error) {
      report('observer', error);
    }
  }
}

/**
 * Wrap one prototype's `write`. The named parameters keep `wrapper.length` at the original's arity
 * and `arguments` forwards exactly what the caller passed, count included. `nests` marks
 * `OutgoingMessage.write`, which writes to its socket synchronously: a socket stall inside it is
 * the message's stall, so it is counted once, on the message.
 */
function createWrapper(patch: Patch, session: Session, nests: boolean): WriteFn {
  const original = patch.original;
  /* eslint-disable @typescript-eslint/no-unused-vars, prefer-rest-params -- see the doc comment */
  const wrapper = nests
    ? function write(
        this: unknown,
        chunk: unknown,
        encoding?: unknown,
        callback?: unknown,
      ): unknown {
        session.suppress += 1;
        let result: unknown;
        try {
          result = Reflect.apply(original, this, arguments);
        } finally {
          session.suppress -= 1;
        }
        if (result === false && patch.active && session.suppress === 0) {
          notify(this, wrapper);
        }
        return result;
      }
    : function write(
        this: unknown,
        chunk: unknown,
        encoding?: unknown,
        callback?: unknown,
      ): unknown {
        const result: unknown = Reflect.apply(original, this, arguments);
        if (result === false && patch.active && session.suppress === 0) {
          notify(this, wrapper);
        }
        return result;
      };
  /* eslint-enable @typescript-eslint/no-unused-vars, prefer-rest-params */
  Object.defineProperty(wrapper, 'length', { value: original.length, configurable: true });
  Object.defineProperty(wrapper, WRAPPER_KEY, { value: patch });
  return wrapper;
}

function isDeadRecord(value: unknown): value is { active: false; original: WriteFn } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { active?: unknown }).active === false &&
    typeof (value as { original?: unknown }).original === 'function'
  );
}

/** Skip inactive Argus wrappers left on top of the chain (a third party restored one of them). */
function peel(fn: WriteFn): WriteFn {
  let current = fn;
  for (let i = 0; i < MAX_PEEL; i += 1) {
    const record = (current as unknown as Record<symbol, unknown>)[WRAPPER_KEY];
    if (!isDeadRecord(record)) {
      return current;
    }
    current = record.original;
  }
  return current;
}

function patchTarget(session: Session, target: object, nests: boolean): void {
  const holder = target as { write?: unknown };
  try {
    const current = holder.write;
    if (typeof current !== 'function') {
      return;
    }
    // A prototype that inherits a wrapper this install already placed is covered by it.
    if (session.patches.some((patch) => patch.wrapper === current)) {
      return;
    }
    const patch: Patch = {
      target: holder,
      hadOwn: Object.hasOwn(target, 'write'),
      original: peel(current as WriteFn),
      wrapper: undefined,
      active: true,
    };
    const wrapper = createWrapper(patch, session, nests);
    patch.wrapper = wrapper;
    holder.write = wrapper;
    session.patches.push(patch);
  } catch (error) {
    // A frozen prototype (for example under --frozen-intrinsics) cannot be patched; leave it alone.
    report('install', error);
  }
}

function install(): void {
  if (registry.session !== undefined) {
    return;
  }
  const session: Session = { patches: [], suppress: 0 };
  registry.session = session;
  patchTarget(session, Writable.prototype, false);
  patchTarget(session, Duplex.prototype, false);
  patchTarget(session, OutgoingMessage.prototype, true);
}

function uninstall(): void {
  const session = registry.session;
  if (session === undefined) {
    return;
  }
  registry.session = undefined;
  for (const patch of session.patches) {
    // From here on the wrapper is a pass-through to `patch.original`, wherever it still sits.
    patch.active = false;
    try {
      // Never clobber a wrapper someone else installed after ours.
      if (patch.target.write === patch.wrapper) {
        if (patch.hadOwn) {
          patch.target.write = patch.original;
        } else {
          delete patch.target.write;
        }
      }
    } catch (error) {
      report('uninstall', error);
    }
  }
}

// ---- Probe -----------------------------------------------------------------------------------

export function createBackpressureProbe(options: BackpressureProbeOptions = {}): BackpressureProbe {
  const maxHotspots = options.maxHotspots ?? DEFAULT_MAX_HOTSPOTS;
  if (!Number.isSafeInteger(maxHotspots) || maxHotspots <= 0) {
    throw new RangeError(`maxHotspots must be a positive safe integer, got ${String(maxHotspots)}`);
  }

  let window = emptyWindow();
  let enabled = false;
  const open = new WeakMap<object, OpenStall>();

  const statsFor = (site: string): SiteStats => {
    let key = site;
    let stats = window.sites.get(key);
    if (stats === undefined) {
      if (window.sites.size >= MAX_SITES_PER_WINDOW) {
        key = OTHER_SITE;
        stats = window.sites.get(key);
      }
      if (stats === undefined) {
        stats = { events: 0, totalStall: 0, maxStall: 0 };
        window.sites.set(key, stats);
      }
    }
    return stats;
  };

  const observe: Observer = (stream, wrapper) => {
    if (open.has(stream)) {
      return;
    }
    const site = siteOf(stream, wrapper);
    open.set(stream, { start: process.hrtime.bigint(), site });
    window.events = saturatingAdd(window.events, 1);
    const stats = statsFor(site);
    stats.events = saturatingAdd(stats.events, 1);

    const onDrain = (): void => {
      stream.removeListener('close', onClose);
      const stall = open.get(stream);
      open.delete(stream);
      if (stall === undefined || !enabled) {
        return;
      }
      const duration = toNonNegativeInt(Number(process.hrtime.bigint() - stall.start));
      window.totalStall = saturatingAdd(window.totalStall, duration);
      window.maxStall = Math.max(window.maxStall, duration);
      const siteStats = statsFor(stall.site);
      siteStats.totalStall = saturatingAdd(siteStats.totalStall, duration);
      siteStats.maxStall = Math.max(siteStats.maxStall, duration);
    };
    const onClose = (): void => {
      stream.removeListener('drain', onDrain);
      open.delete(stream);
    };
    stream.once('drain', onDrain);
    stream.once('close', onClose);
  };

  return {
    enable(): void {
      if (enabled) {
        return;
      }
      enabled = true;
      window = emptyWindow();
      registry.observers.add(observe);
      install();
    },
    disable(): void {
      if (!enabled) {
        return;
      }
      enabled = false;
      registry.observers.delete(observe);
      if (registry.observers.size === 0) {
        uninstall();
      }
    },
    sample(): BackpressureSample {
      const hotspots: BackpressureHotspot[] = [...window.sites.entries()]
        .map(([site, stats]) => ({ site, ...stats }))
        .sort(
          (a, b) =>
            b.totalStall - a.totalStall ||
            b.events - a.events ||
            (a.site < b.site ? -1 : a.site > b.site ? 1 : 0),
        )
        .slice(0, maxHotspots);
      const result: BackpressureSample = {
        events: window.events,
        totalStall: window.totalStall,
        maxStall: window.maxStall,
        hotspots,
      };
      window = emptyWindow();
      return result;
    },
  };
}
