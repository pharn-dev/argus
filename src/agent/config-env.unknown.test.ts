import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultAgentConfig, loadAgentConfig } from './index.js';

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'argus-config-unknown-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('agent config — unknown ARGUS_* variables (F-09)', () => {
  it('warns once per unknown variable, naming it, and ignores it', async () => {
    const cwd = await makeTempDir();
    const warnings: string[] = [];
    const config = await loadAgentConfig(
      cwd,
      { ARGUS_FOO: '1', ARGUS_INTERVAL_MS: '250' },
      { onWarning: (message) => warnings.push(message) },
    );
    expect(config).toEqual({ ...defaultAgentConfig, intervalMs: 250 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ARGUS_FOO');
    expect(warnings[0]).not.toContain('did you mean');
  });

  it('suggests the closest known variable for a likely typo', async () => {
    const cwd = await makeTempDir();
    const warnings: string[] = [];
    await loadAgentConfig(
      cwd,
      { ARGUS_OUTPT: 'none', ARGUS_INTERVAL: '5' },
      { onWarning: (message) => warnings.push(message) },
    );
    expect(warnings).toEqual([
      'ignoring unknown environment variable ARGUS_OUTPT (did you mean ARGUS_OUTPUT?)',
      'ignoring unknown environment variable ARGUS_INTERVAL (did you mean ARGUS_INTERVAL_MS?)',
    ]);
  });

  it('still fails on an invalid value for a known variable', async () => {
    const cwd = await makeTempDir();
    await expect(
      loadAgentConfig(cwd, { ARGUS_QUEUE_BOUND: 'lots' }, { onWarning: () => undefined }),
    ).rejects.toThrow(/ARGUS_QUEUE_BOUND/);
  });
});
