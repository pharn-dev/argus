import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type AgentConfigUnderTest = Readonly<{
  intervalMs: number;
  output: string;
  queueBound: number;
  enabled: boolean;
}>;

type ConfigModuleUnderTest = {
  loadAgentConfig(
    cwd: string,
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<AgentConfigUnderTest>;
  defaultAgentConfig: AgentConfigUnderTest;
};

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'argus-config-ac1-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('agent config — AC-1', () => {
  it('AC-1: env overrides the JSON file interval, the file output is kept, ARGUS_ENABLED "0" disables, queue bound is the default, and the config is frozen', async () => {
    const { loadAgentConfig, defaultAgentConfig } =
      (await import('./index.js')) as unknown as ConfigModuleUnderTest;

    const dir = await makeTempDir();
    const outputPath = path.join(dir, 'out', 'argus.ndjson');
    expect(path.isAbsolute(outputPath)).toBe(true);
    await writeFile(
      path.join(dir, 'argus.config.json'),
      JSON.stringify({ intervalMs: 250, output: outputPath }),
      'utf8',
    );

    const config = await loadAgentConfig(dir, {
      ARGUS_INTERVAL_MS: '750',
      ARGUS_ENABLED: '0',
    });

    expect(config.intervalMs).toBe(750);
    expect(config.output).toBe(outputPath);
    expect(config.enabled).toBe(false);
    expect(config.queueBound).toBe(defaultAgentConfig.queueBound);
    expect(Object.isFrozen(config)).toBe(true);
  });
});
