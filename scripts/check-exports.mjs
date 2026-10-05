// Smoke test for the built package: every subpath in package.json "exports" must load from both
// ESM (import) and CommonJS (require). Run after `npm run build`.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);
let failed = false;

for (const subpath of Object.keys(pkg.exports)) {
  if (subpath === './package.json') continue;
  const specifier = `${pkg.name}${subpath.slice(1)}`;
  for (const [format, load] of [
    ['import', () => import(specifier)],
    ['require', () => Promise.resolve(require(specifier))],
  ]) {
    try {
      await load();
      console.log(`ok   ${format.padEnd(7)} ${specifier}`);
    } catch (error) {
      failed = true;
      console.error(
        `FAIL ${format.padEnd(7)} ${specifier}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

process.exitCode = failed ? 1 : 0;
