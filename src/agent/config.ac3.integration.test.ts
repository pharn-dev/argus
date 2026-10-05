import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type ConfigModuleUnderTest = {
  loadAgentConfig(cwd: string, env: Readonly<Record<string, string | undefined>>): Promise<unknown>;
};

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'argus-config-ac3-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function messageOfFailure(
  loadAgentConfig: ConfigModuleUnderTest['loadAgentConfig'],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  let caught: unknown;
  let resolved = false;
  try {
    await loadAgentConfig(cwd, env);
    resolved = true;
  } catch (error: unknown) {
    caught = error;
  }
  expect(resolved).toBe(false);
  expect(caught).toBeInstanceOf(Error);
  return (caught as Error).message;
}

describe('agent config — AC-3', () => {
  it('AC-3: every invalid source fails with an error naming the source and the key, and two config files fail naming both', async () => {
    const { loadAgentConfig } = (await import('./index.js')) as unknown as ConfigModuleUnderTest;

    // 1. argus.config.json that is not valid JSON
    const invalidJsonDir = await makeTempDir();
    await writeFile(path.join(invalidJsonDir, 'argus.config.json'), '{ "intervalMs": 100,', 'utf8');
    const invalidJsonMessage = await messageOfFailure(loadAgentConfig, invalidJsonDir, {});
    expect(invalidJsonMessage).toContain('argus.config.json');

    // 2. argus.config.json with an unknown key foo
    const unknownKeyDir = await makeTempDir();
    await writeFile(
      path.join(unknownKeyDir, 'argus.config.json'),
      JSON.stringify({ foo: 1 }),
      'utf8',
    );
    const unknownKeyMessage = await messageOfFailure(loadAgentConfig, unknownKeyDir, {});
    expect(unknownKeyMessage).toContain('argus.config.json');
    expect(unknownKeyMessage).toContain('foo');

    // 3. argus.config.json setting the queue bound to 0
    const zeroBoundDir = await makeTempDir();
    await writeFile(
      path.join(zeroBoundDir, 'argus.config.json'),
      JSON.stringify({ queueBound: 0 }),
      'utf8',
    );
    const zeroBoundMessage = await messageOfFailure(loadAgentConfig, zeroBoundDir, {});
    expect(zeroBoundMessage).toContain('argus.config.json');
    expect(zeroBoundMessage).toContain('queueBound');

    // 4. ARGUS_INTERVAL_MS set to "abc"
    const badIntervalDir = await makeTempDir();
    const badIntervalMessage = await messageOfFailure(loadAgentConfig, badIntervalDir, {
      ARGUS_INTERVAL_MS: 'abc',
    });
    expect(badIntervalMessage).toContain('ARGUS_INTERVAL_MS');
    expect(badIntervalMessage).toContain('intervalMs');

    // 5. ARGUS_ENABLED set to "yes"
    const badEnabledDir = await makeTempDir();
    const badEnabledMessage = await messageOfFailure(loadAgentConfig, badEnabledDir, {
      ARGUS_ENABLED: 'yes',
    });
    expect(badEnabledMessage).toContain('ARGUS_ENABLED');
    expect(badEnabledMessage).toContain('enabled');

    // 6. both argus.config.json and argus.config.js present
    const bothDir = await makeTempDir();
    await writeFile(
      path.join(bothDir, 'package.json'),
      JSON.stringify({ type: 'commonjs' }),
      'utf8',
    );
    await writeFile(
      path.join(bothDir, 'argus.config.json'),
      JSON.stringify({ intervalMs: 100 }),
      'utf8',
    );
    await writeFile(
      path.join(bothDir, 'argus.config.js'),
      'module.exports = { intervalMs: 200 };\n',
      'utf8',
    );
    const bothMessage = await messageOfFailure(loadAgentConfig, bothDir, {});
    expect(bothMessage).toContain('argus.config.json');
    expect(bothMessage).toContain('argus.config.js');
  });
});
