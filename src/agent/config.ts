import { readConfigEnv } from './config-env.js';
import { readConfigFile } from './config-file.js';
import { defaultAgentConfig } from './config-schema.js';
import type { AgentConfig } from './config-schema.js';

/** Resolve the agent config: defaults, then argus.config.json/js in `cwd`, then ARGUS_* env. */
export async function loadAgentConfig(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<AgentConfig> {
  const fromEnv = readConfigEnv(env, cwd);
  const fromFile = await readConfigFile(cwd);
  return Object.freeze({ ...defaultAgentConfig, ...fromFile, ...fromEnv });
}
