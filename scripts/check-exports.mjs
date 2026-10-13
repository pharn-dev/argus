// Smoke test for the built package: every subpath in package.json "exports" must load from both
// ESM (import) and CommonJS (require). Run after `npm run build`.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

// Every "bin" entry: the file exists, starts with the shebang, is executable (POSIX) and answers
// --help with the serve command in its usage text.
for (const [name, target] of Object.entries(pkg.bin ?? {})) {
  const file = fileURLToPath(new URL(`../${target}`, import.meta.url));
  try {
    if (!readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node\n')) {
      throw new Error(`${target} does not start with "#!/usr/bin/env node"`);
    }
    if (process.platform !== 'win32' && (statSync(file).mode & 0o111) === 0) {
      throw new Error(`${target} is not executable`);
    }
    const stdout = execFileSync(process.execPath, [file, '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!stdout.includes('serve')) {
      throw new Error(`${target} --help does not mention serve`);
    }
    console.log(`ok   ${'bin'.padEnd(7)} ${name}`);
  } catch (error) {
    failed = true;
    console.error(
      `FAIL ${'bin'.padEnd(7)} ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

process.exitCode = failed ? 1 : 0;
