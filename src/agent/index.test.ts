import { describe, expect, it } from 'vitest';

describe('agent', () => {
  it('loads the scaffold entrypoint', async () => {
    const mod = await import('./index.js');
    expect(mod).toBeDefined();
  });
});
