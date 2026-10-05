/// <reference types="node" />
import type { Writable } from 'node:stream';

/** Streams the backpressure probe must ignore, such as the agent's own export destination. */
const excluded = new WeakSet<Writable>();

export function excludeFromBackpressure(stream: Writable): void {
  excluded.add(stream);
}

export function isExcludedFromBackpressure(stream: Writable): boolean {
  return excluded.has(stream);
}
