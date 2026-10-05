import { describe, expect, it } from 'vitest';
import type { CollectorPlaceholder } from './index.js';

describe('collector', () => {
  it('wires collector types to the agent scaffold', () => {
    const placeholder: CollectorPlaceholder = undefined;
    expect(placeholder).toBeUndefined();
  });
});
