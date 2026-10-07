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

/** Edit distance between two short strings (variable names), two-row dynamic programming. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

const SUGGESTION_MAX_DISTANCE = 3;

/** The closest known variable to an unknown ARGUS_* name, when it is plausibly a typo. */
function suggest(name: string): string | undefined {
  const typed = name.slice('ARGUS_'.length);
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const known of Object.keys(VARIABLES)) {
    const distance = editDistance(typed, known.slice('ARGUS_'.length));
    if (distance < bestDistance) {
      best = known;
      bestDistance = distance;
    }
  }
  // Short names are only "close" when most of the name survives the edit.
  return bestDistance <= SUGGESTION_MAX_DISTANCE && bestDistance * 2 < typed.length
    ? best
    : undefined;
}

/** The warning text for an ignored, unknown ARGUS_* variable. */
export function unknownVariableWarning(name: string): string {
  const suggestion = suggest(name);
  return `ignoring unknown environment variable ${name}${
    suggestion === undefined ? '' : ` (did you mean ${suggestion}?)`
  }`;
}

/**
 * Map ARGUS_* variables to config keys. Other variables are ignored. An unknown ARGUS_ name is
 * reported once through `warn` and ignored; an invalid value for a known name throws.
 */
export function readConfigEnv(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  warn: (message: string) => void,
): Partial<AgentConfig> {
  const result: Record<string, unknown> = {};
  for (const [name, text] of Object.entries(env)) {
    if (!name.startsWith('ARGUS_') || text === undefined) {
      continue;
    }
    if (!Object.hasOwn(VARIABLES, name)) {
      warn(unknownVariableWarning(name));
      continue;
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
