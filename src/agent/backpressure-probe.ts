/// <reference types="node" />
import { Writable } from 'node:stream';
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
type Observer = (stream: Writable) => void;

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

const enabledObservers = new Set<Observer>();
const siteCache = new WeakMap<Writable, string>();
type WriteFn = typeof Writable.prototype.write;
let original: WriteFn | undefined;

/** This module's own file as it appears in stacks, found once at load (works under ESM and CJS). */
const ownFiles: ReadonlySet<string> = (() => {
  const site = siteFromStack(new Error('probe').stack ?? '', new Set());
  if (site === undefined) {
    return new Set<string>();
  }
  return new Set<string>([site.slice(0, site.lastIndexOf(':'))]);
})();

function fallbackSite(stream: Writable): string {
  const name = stream.constructor.name;
  return name === '' ? 'Writable' : name;
}

/** Capture the call site of a stream's first stall. Runs once per stream. */
function siteOf(stream: Writable): string {
  const cached = siteCache.get(stream);
  if (cached !== undefined) {
    return cached;
  }
  let site: string | undefined;
  const previousLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = STACK_LIMIT;
    const holder: { stack?: string } = {};
    Error.captureStackTrace(holder, patchedWrite);
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

function patchedWrite(this: Writable, ...args: unknown[]): boolean {
  const base = original;
  if (base === undefined) {
    throw new Error('backpressure probe: write wrapper called without an original');
  }
  const result = Reflect.apply(base, this, args) as boolean;
  if (!result && enabledObservers.size > 0 && !isExcludedFromBackpressure(this)) {
    for (const observer of [...enabledObservers]) {
      observer(this);
    }
  }
  return result;
}

function install(): void {
  if (original !== undefined) {
    return;
  }
  // Captured only to be re-applied with Reflect.apply and restored by identity, never called unbound.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  original = Writable.prototype.write;
  Writable.prototype.write = patchedWrite;
}

function uninstall(): void {
  const base = original;
  if (base === undefined) {
    return;
  }
  original = undefined;
  // Never clobber a wrapper someone else installed after ours.
  if (Writable.prototype.write === (patchedWrite as unknown as WriteFn)) {
    Writable.prototype.write = base;
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
  const open = new WeakMap<Writable, OpenStall>();

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

  const observe: Observer = (stream) => {
    if (open.has(stream)) {
      return;
    }
    const site = siteOf(stream);
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
      enabledObservers.add(observe);
      install();
    },
    disable(): void {
      if (!enabled) {
        return;
      }
      enabled = false;
      enabledObservers.delete(observe);
      if (enabledObservers.size === 0) {
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
