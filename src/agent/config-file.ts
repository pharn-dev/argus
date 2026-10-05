import { stat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { types } from 'node:util';
import { ArgusConfigError, isConfigKey, validateConfigValue } from './config-schema.js';
import type { AgentConfig } from './config-schema.js';

const JSON_NAME = 'argus.config.json';
const JS_NAME = 'argus.config.js';

async function exists(cwd: string, name: string): Promise<boolean> {
  try {
    await stat(path.join(cwd, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw new ArgusConfigError(name, undefined, 'cannot be accessed', { cause: error });
  }
}

async function loadRaw(cwd: string, name: string): Promise<unknown> {
  const file = path.join(cwd, name);
  if (name === JSON_NAME) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      throw new ArgusConfigError(name, undefined, 'cannot be read', { cause: error });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ArgusConfigError(name, undefined, 'not valid JSON', { cause: error });
    }
  }
  try {
    // createRequire behaves the same in the ESM and CJS builds, unlike import().
    const loaded: unknown = createRequire(path.join(cwd, 'noop.js'))(file);
    return types.isModuleNamespaceObject(loaded)
      ? (loaded as { default?: unknown }).default
      : loaded;
  } catch (error) {
    throw new ArgusConfigError(name, undefined, 'failed to load', { cause: error });
  }
}

/** Read argus.config.json or argus.config.js from `cwd` (no parent search). Absent -> {}. */
export async function readConfigFile(cwd: string): Promise<Partial<AgentConfig>> {
  const hasJson = await exists(cwd, JSON_NAME);
  const hasJs = await exists(cwd, JS_NAME);
  if (hasJson && hasJs) {
    throw new ArgusConfigError(
      `${JSON_NAME} and ${JS_NAME}`,
      undefined,
      'both exist; keep only one',
    );
  }
  if (!hasJson && !hasJs) {
    return {};
  }
  const name = hasJson ? JSON_NAME : JS_NAME;
  const raw = await loadRaw(cwd, name);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ArgusConfigError(name, undefined, 'must export or contain a plain object');
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!isConfigKey(key)) {
      throw new ArgusConfigError(name, key, 'unknown key');
    }
    const value = (raw as Record<string, unknown>)[key];
    validateConfigValue(name, key, value);
    result[key] =
      key === 'output' && value !== 'stdout' && value !== 'none'
        ? path.resolve(cwd, value as string)
        : value;
  }
  return result;
}
