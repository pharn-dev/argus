import { describe, expect, it } from 'vitest';

describe('analyzer', () => {
  it('loads the scaffold entrypoint', async () => {
    const mod = await import('./index.js');
    expect(mod).toBeDefined();
  });
});
