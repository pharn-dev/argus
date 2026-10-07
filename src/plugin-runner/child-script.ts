import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This module's own directory, without `import.meta` (the CJS build rejects it). */
function ownDirectory(): string | undefined {
  if (typeof __dirname === 'string') {
    return __dirname;
  }
  const stack = new Error().stack ?? '';
  for (const line of stack.split('\n')) {
    const match = /(file:\/\/\/[^\s)]+|\/[^\s):]+|[A-Za-z]:\\[^\s)]+?)(?::\d+:\d+)\)?\s*$/.exec(
      line,
    );
    const location = match?.[1];
    if (location === undefined) {
      continue;
    }
    try {
      const path = location.startsWith('file://') ? fileURLToPath(location) : location;
      return dirname(path);
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Locates the sandbox child entry: the compiled `.js` in the built trees, else the `.ts`
 * source (run under Node's type stripping). Returns an Error naming what was searched.
 */
export function resolveChildScript(): string | Error {
  const directory = ownDirectory();
  if (directory === undefined) {
    return new Error(
      'could not determine the directory of argus/plugin-runner to find the sandbox child',
    );
  }
  const compiled = join(directory, 'workers', 'sandbox-child.js');
  if (existsSync(compiled)) {
    return compiled;
  }
  const source = join(directory, 'workers', 'sandbox-child.ts');
  if (existsSync(source)) {
    return source;
  }
  return new Error(`sandbox child script not found (looked for ${compiled} and ${source})`);
}
