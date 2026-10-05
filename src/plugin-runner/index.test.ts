import { describe, expect, it } from 'vitest';
import type { PluginRunnerPlaceholder } from './index.js';

describe('plugin-runner', () => {
  it('wires plugin-runner types to the collector scaffold', () => {
    const placeholder: PluginRunnerPlaceholder = undefined;
    expect(placeholder).toBeUndefined();
  });
});
