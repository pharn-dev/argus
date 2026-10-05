/** Resolved agent configuration. `output` is 'stdout', 'none' (disabled) or an absolute file path. */
export type AgentConfig = Readonly<{
  intervalMs: number;
  output: string;
  queueBound: number;
  enabled: boolean;
}>;

export type AgentConfigKey = keyof AgentConfig;

export const defaultAgentConfig: AgentConfig = Object.freeze({
  intervalMs: 1000,
  output: 'stdout',
  queueBound: 1024,
  enabled: true,
});

export const CONFIG_KEYS: readonly AgentConfigKey[] = [
  'intervalMs',
  'output',
  'queueBound',
  'enabled',
];

const INTERVAL_MS_MAX = 3_600_000;
const QUEUE_BOUND_MAX = 1_000_000;

/** A config problem that names its source (file or variable) and, when known, the key. */
export class ArgusConfigError extends Error {
  readonly source: string;
  readonly key: string | undefined;

  constructor(source: string, key: string | undefined, reason: string, options?: ErrorOptions) {
    super(`argus config: ${source}${key === undefined ? '' : `: ${key}`}: ${reason}`, options);
    this.name = 'ArgusConfigError';
    this.source = source;
    this.key = key;
  }
}

export function isConfigKey(key: string): key is AgentConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

function validateInteger(
  source: string,
  key: string,
  value: unknown,
  min: number,
  max: number,
): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ArgusConfigError(
      source,
      key,
      `expected an integer from ${String(min)} to ${String(max)}, got ${describe(value)}`,
    );
  }
}

function describe(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return typeof value;
}

/** Validate one already-typed value for a known key. Throws ArgusConfigError. */
export function validateConfigValue(source: string, key: AgentConfigKey, value: unknown): void {
  switch (key) {
    case 'intervalMs':
      validateInteger(source, key, value, 1, INTERVAL_MS_MAX);
      return;
    case 'queueBound':
      validateInteger(source, key, value, 1, QUEUE_BOUND_MAX);
      return;
    case 'enabled':
      if (typeof value !== 'boolean') {
        throw new ArgusConfigError(source, key, `expected a boolean, got ${describe(value)}`);
      }
      return;
    case 'output':
      if (typeof value !== 'string' || value.length === 0) {
        throw new ArgusConfigError(
          source,
          key,
          `expected a non-empty string, got ${describe(value)}`,
        );
      }
      return;
  }
}
