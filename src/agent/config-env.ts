import path from 'node:path';
import { ArgusConfigError, validateConfigValue } from './config-schema.js';
import type { AgentConfig, AgentConfigKey } from './config-schema.js';

const VARIABLES: Readonly<Record<string, AgentConfigKey>> = {
  ARGUS_INTERVAL_MS: 'intervalMs',
  ARGUS_OUTPUT: 'output',
  ARGUS_QUEUE_BOUND: 'queueBound',
  ARGUS_ENABLED: 'enabled',
};

function parse(name: string, key: AgentConfigKey, text: string): unknown {
  switch (key) {
    case 'intervalMs':
    case 'queueBound':
      if (!/^[0-9]+$/.test(text)) {
        throw new ArgusConfigError(
          name,
          key,
          `expected a non-negative integer, got ${JSON.stringify(text)}`,
        );
      }
      return Number(text);
    case 'enabled':
      if (text === 'true' || text === '1') {
        return true;
      }
      if (text === 'false' || text === '0') {
        return false;
      }
      throw new ArgusConfigError(
        name,
        key,
        `expected true, false, 1 or 0, got ${JSON.stringify(text)}`,
      );
    case 'output':
      return text;
  }
}

/** Map ARGUS_* variables to config keys. Other variables are ignored; unknown ARGUS_ names throw. */
export function readConfigEnv(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): Partial<AgentConfig> {
  const result: Record<string, unknown> = {};
  for (const [name, text] of Object.entries(env)) {
    if (!name.startsWith('ARGUS_') || text === undefined) {
      continue;
    }
    if (!Object.hasOwn(VARIABLES, name)) {
      throw new ArgusConfigError(name, undefined, 'unknown variable');
    }
    const key = VARIABLES[name] as AgentConfigKey;
    const value = parse(name, key, text);
    validateConfigValue(name, key, value);
    result[key] =
      key === 'output' && value !== 'stdout' && value !== 'none'
        ? path.resolve(cwd, value as string)
        : value;
  }
  return result;
}
