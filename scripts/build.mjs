// Builds both module formats into dist/: ESM -> dist/esm, CommonJS -> dist/cjs.
// Each output directory gets a package.json that pins its module type, so Node and TypeScript read
// the .js and .d.ts files there in the right format whatever the root package's own "type" is.
// The CommonJS build uses moduleResolution Node10 (tsconfig.cjs.json): TypeScript 6 only accepts it
// with ignoreDeprecations, and TypeScript 7 removes it, so revisit that file when upgrading to 7.
// Source maps embed their sources (tsconfig.base.json inlineSources): src/ is not published, so a map
// that only named ../../../src/... would point at nothing. Declaration maps are off for the same
// reason: they cannot embed sources, and without src/ they only send go-to-definition to a missing file.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));

rmSync(`${root}dist`, { recursive: true, force: true });

for (const [project, outDir, type] of [
  ['tsconfig.esm.json', 'dist/esm', 'module'],
  ['tsconfig.cjs.json', 'dist/cjs', 'commonjs'],
]) {
  execFileSync(process.execPath, [tsc, '-p', project], { cwd: root, stdio: 'inherit' });
  mkdirSync(`${root}${outDir}`, { recursive: true });
  writeFileSync(`${root}${outDir}/package.json`, `${JSON.stringify({ type })}\n`);
}

// Every "bin" target must keep its shebang through tsc and be executable on disk (npm also marks
// bin targets executable inside the tarball).
const manifest = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
for (const [name, target] of Object.entries(manifest.bin ?? {})) {
  const file = `${root}${target}`;
  if (!readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node\n')) {
    throw new Error(`bin "${name}" (${target}) must start with "#!/usr/bin/env node"`);
  }
  chmodSync(file, 0o755);
}
