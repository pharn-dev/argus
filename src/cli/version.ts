import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@pharn-dev/phargus';
/** How many directories above this file to look; dist/esm/cli and src/cli both sit well inside it. */
const MAX_LEVELS = 6;

/**
 * The version in the package's own `package.json`: the first one walking up from this file whose
 * `name` is `@pharn-dev/phargus`. It skips the name-less `dist/esm/package.json` the build writes.
 */
export function readPackageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    const candidate = join(directory, 'package.json');
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`cannot read ${candidate}: ${(error as Error).message}`, { cause: error });
      }
    }
    if (typeof manifest === 'object' && manifest !== null) {
      const { name, version } = manifest as { name?: unknown; version?: unknown };
      if (name === PACKAGE_NAME && typeof version === 'string') {
        return version;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error(`cannot find the ${PACKAGE_NAME} package.json to read the version from`);
}
