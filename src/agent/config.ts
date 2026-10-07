import { readConfigEnv } from './config-env.js';
import { readConfigFile } from './config-file.js';
import { defaultAgentConfig } from './config-schema.js';
import type { AgentConfig } from './config-schema.js';

export type LoadAgentConfigOptions = {
  /**
   * Receives each non-fatal config problem (an unknown ARGUS_* variable, which is ignored).
   * Defaults to one `[argus] warning: ...` line on stderr per problem.
   */
  onWarning?: (message: string) => void;
};

function warnOnStderr(message: string): void {
  try {
    process.stderr.write(`[argus] warning: ${message.replace(/\s+/g, ' ').trim()}\n`);
  } catch {
    // A warning must never throw into the caller; stderr is the only channel.
  }
}

/** Resolve the agent config: defaults, then argus.config.json/js in `cwd`, then ARGUS_* env. */
export async function loadAgentConfig(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  options: LoadAgentConfigOptions = {},
): Promise<AgentConfig> {
  const fromEnv = readConfigEnv(env, cwd, options.onWarning ?? warnOnStderr);
  const fromFile = await readConfigFile(cwd);
  return Object.freeze({ ...defaultAgentConfig, ...fromFile, ...fromEnv });
}
