import { describe, expect, it } from 'vitest';
import type { DashboardPlaceholder } from './index.js';

describe('dashboard', () => {
  it('wires dashboard types to the collector scaffold', () => {
    const placeholder: DashboardPlaceholder = undefined;
    expect(placeholder).toBeUndefined();
  });
});
