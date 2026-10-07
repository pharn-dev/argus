// Shared helpers for the benchmark and soak harnesses. Node core only.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function describe(err) {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Resolve the built `argus/agent` entry through the package's own `exports` (self-reference by
 * package name), so the harness measures exactly what `--import argus/agent` loads for a user.
 * Throws with a hint when `dist/` has not been built.
 */
export function resolveAgent() {
  let agentUrl;
  try {
    agentUrl = import.meta.resolve('argus/agent');
  } catch (err) {
    throw new Error(`cannot resolve argus/agent; run \`npm run build\` first (${describe(err)})`, {
      cause: err,
    });
  }
  // The library API without the auto-start side effect. It is not an `exports` subpath, so it is
  // derived from the resolved entry: dist/esm/agent/index.js sits next to dist/esm/agent/auto.js.
  const indexUrl = new URL('./index.js', agentUrl).href;
  for (const url of [agentUrl, indexUrl]) {
    if (!existsSync(fileURLToPath(url))) {
      throw new Error(`${fileURLToPath(url)} is missing; run \`npm run build\` first`);
    }
  }
  return { agentUrl, indexUrl };
}

/** The parent environment without any ARGUS_* variable (an unknown one disables the agent). */
export function cleanEnv(extra) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('ARGUS_')) env[name] = value;
  }
  return { ...env, ...extra };
}

/** Comma-separated list from the CLI, validated against the allowed names. */
export function parseList(flag, text, allowed) {
  const items = text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (items.length === 0) throw new Error(`--${flag} must name at least one of ${allowed}`);
  for (const item of items) {
    if (!allowed.includes(item)) {
      throw new Error(`--${flag}: unknown value "${item}" (allowed: ${allowed.join(', ')})`);
    }
  }
  return [...new Set(items)];
}

/** A positive number from the CLI (seconds may be fractional). */
export function parsePositive(flag, text, { integer = false } = {}) {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(
      `--${flag} must be a positive ${integer ? 'integer' : 'number'}, got ${JSON.stringify(text)}`,
    );
  }
  return value;
}

/** Git commit of the checkout, for the result file. Falls back to CI's variable, then null. */
export function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (err) {
    process.stderr.write(`[bench] git rev-parse failed, commit not recorded: ${describe(err)}\n`);
    return process.env.GITHUB_SHA ?? null;
  }
}
