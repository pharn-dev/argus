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
};

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'argus-config-ac2-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('agent config — AC-2', () => {
  it('AC-2: a CommonJS argus.config.js (module.exports) and an ESM argus.config.js (export default) each supply their interval, queue bound and output', async () => {
    const { loadAgentConfig } = (await import('./index.js')) as unknown as ConfigModuleUnderTest;

    const cjsDir = await makeTempDir();
    const cjsOutput = path.join(cjsDir, 'cjs-out.ndjson');
    await writeFile(
      path.join(cjsDir, 'package.json'),
      JSON.stringify({ type: 'commonjs' }),
      'utf8',
    );
    await writeFile(
      path.join(cjsDir, 'argus.config.js'),
      `module.exports = { intervalMs: 321, queueBound: 77, output: ${JSON.stringify(cjsOutput)} };\n`,
      'utf8',
    );

    const esmDir = await makeTempDir();
    const esmOutput = path.join(esmDir, 'esm-out.ndjson');
    await writeFile(path.join(esmDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(
      path.join(esmDir, 'argus.config.js'),
      `export default { intervalMs: 654, queueBound: 88, output: ${JSON.stringify(esmOutput)} };\n`,
      'utf8',
    );

    const cjsConfig = await loadAgentConfig(cjsDir, {});
    expect(cjsConfig.intervalMs).toBe(321);
    expect(cjsConfig.queueBound).toBe(77);
    expect(cjsConfig.output).toBe(cjsOutput);

    const esmConfig = await loadAgentConfig(esmDir, {});
    expect(esmConfig.intervalMs).toBe(654);
    expect(esmConfig.queueBound).toBe(88);
    expect(esmConfig.output).toBe(esmOutput);
  });
});
