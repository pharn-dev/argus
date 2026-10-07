/** One allocation site: where bytes were allocated, summed over the sampled profile. */
export type AllocationSite = {
  functionName: string;
  url: string;
  /** 1-based line number (as in stack traces and editors); `0` when V8 reports no line. */
  line: number;
  /** Sampled bytes still live at the end of sampling, as an integer greater than zero. */
  bytes: number;
};

/** Structural view of a V8 sampling heap profile node (no `node:inspector` import needed). */
export type AllocationProfileNode = {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: readonly AllocationProfileNode[];
};

/**
 * Collapse a V8 sampling heap profile tree into allocation sites, largest first.
 * Nodes are keyed by function name, url and line; their `selfSize` values are summed
 * with integer math. Ties are ordered by url, line, then function name. Returns at
 * most `limit` sites.
 */
export function aggregateAllocationProfile(
  head: AllocationProfileNode,
  limit: number,
): AllocationSite[] {
  const sites = new Map<string, AllocationSite>();
  const stack: AllocationProfileNode[] = [head];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const size = Math.trunc(node.selfSize);
    if (size > 0) {
      const { functionName, url, lineNumber } = node.callFrame;
      const line = lineNumber >= 0 ? Math.trunc(lineNumber) + 1 : 0;
      const key = `${functionName}\u0000${url}\u0000${line}`;
      const existing = sites.get(key);
      if (existing === undefined) {
        sites.set(key, { functionName, url, line, bytes: Math.min(size, Number.MAX_SAFE_INTEGER) });
      } else {
        existing.bytes = Math.min(existing.bytes + size, Number.MAX_SAFE_INTEGER);
      }
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return [...sites.values()]
    .sort(
      (a, b) =>
        b.bytes - a.bytes ||
        compareStrings(a.url, b.url) ||
        a.line - b.line ||
        compareStrings(a.functionName, b.functionName),
    )
    .slice(0, limit);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
