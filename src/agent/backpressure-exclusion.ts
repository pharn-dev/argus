/// <reference types="node" />
import type { Writable } from 'node:stream';

const EXCLUDED_KEY = Symbol.for('argus.backpressure.excluded.v1');

/**
 * Streams the backpressure probe must ignore, such as the agent's own export destination. Kept on
 * `globalThis` so a second copy of Argus (ESM + CJS) whose probe shares the write wrappers also
 * ignores the first copy's destination.
 */
const excluded: WeakSet<object> = (() => {
  const host = globalThis as unknown as Record<symbol, unknown>;
  const existing = host[EXCLUDED_KEY];
  if (existing instanceof WeakSet) {
    return existing;
  }
  const created = new WeakSet<object>();
  if (existing === undefined) {
    Object.defineProperty(host, EXCLUDED_KEY, { value: created, configurable: true });
  }
  return created;
})();

export function excludeFromBackpressure(stream: Writable | object): void {
  excluded.add(stream);
}

export function isExcludedFromBackpressure(stream: object): boolean {
  return excluded.has(stream);
}
