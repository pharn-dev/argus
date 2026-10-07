import { describe, expect, it } from 'vitest';

// Allocations retained by the test function until the sampling call resolves, so the sampling
// heap profiler (which reports objects still live at stop time) attributes them to it.
const retained: number[][] = [];

// A distinctively named allocator: the sampling call must report it among the allocation sites.
function argusAc1RetainingAllocator(): void {
  for (let i = 0; i < 20; i += 1) {
    retained.push(new Array<number>(4096).fill(i));
  }
}

describe('agent allocation sampling — AC-1', () => {
  it('AC-1: sampleAllocations resolves with non-empty integer-sized sites ordered largest first, including the allocating test function', async () => {
    const { sampleAllocations } = await import('./index.js');

    argusAc1RetainingAllocator();
    const timer = setInterval(argusAc1RetainingAllocator, 5);
    let result: unknown;
    try {
      result = await sampleAllocations({ samplingInterval: 1024, durationMs: 300, limit: 1000 });
    } finally {
      clearInterval(timer);
      retained.length = 0;
    }

    expect(Array.isArray(result), 'resolves with an array').toBe(true);
    const sites = result as unknown[];
    expect(sites.length, 'the list of sites is non-empty').toBeGreaterThan(0);

    let previousBytes = Number.POSITIVE_INFINITY;
    const names: string[] = [];
    for (const [index, entry] of sites.entries()) {
      expect(typeof entry, `site ${index} is an object`).toBe('object');
      expect(entry, `site ${index} is not null`).not.toBeNull();
      const site = entry as Record<string, unknown>;
      const { functionName, url, line, bytes } = site;

      expect(typeof functionName, `site ${index} functionName is a string`).toBe('string');
      expect(typeof url, `site ${index} url is a string`).toBe('string');
      expect(Number.isInteger(line), `site ${index} line is an integer`).toBe(true);
      expect(Number.isInteger(bytes), `site ${index} bytes is an integer`).toBe(true);
      expect(bytes as number, `site ${index} bytes > 0`).toBeGreaterThan(0);
      expect(
        bytes as number,
        `site ${index} is not larger than the site before it`,
      ).toBeLessThanOrEqual(previousBytes);

      previousBytes = bytes as number;
      names.push(functionName as string);
    }

    expect(names, 'the allocating test function appears among the sites').toContain(
      argusAc1RetainingAllocator.name,
    );
  }, 30_000);
});
