import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const exampleDir = join(repoRoot, 'examples', 'worker-pool');
const SOURCE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts', '.mts', '.cts']);
const ARGUS_SPECIFIER = /^argus\/[a-z-]+$/;

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

type Specifiers = {
  readonly literal: string[];
  readonly dynamicCalls: number;
  readonly literalDynamicCalls: number;
};

function moduleSpecifiers(text: string): Specifiers {
  const literal: string[] = [];
  const staticImport = /\bimport\s+(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  const reExport = /\bexport\s+(?:[\w$*{}\s,]+?\s+)?from\s+['"]([^'"]+)['"]/g;
  const dynamicImport = /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
  const requireCall = /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
  for (const m of text.matchAll(staticImport)) literal.push(m[1] ?? '');
  for (const m of text.matchAll(reExport)) literal.push(m[1] ?? '');
  let literalDynamicCalls = 0;
  for (const m of text.matchAll(dynamicImport)) {
    literal.push(m[2] ?? '');
    literalDynamicCalls += 1;
  }
  for (const m of text.matchAll(requireCall)) {
    literal.push(m[2] ?? '');
    literalDynamicCalls += 1;
  }
  const dynamicCalls =
    [...text.matchAll(/\bimport\s*\(/g)].length + [...text.matchAll(/\brequire\s*\(/g)].length;
  return { literal, dynamicCalls, literalDynamicCalls };
}

describe('examples/worker-pool: package-only imports and README', () => {
  it('AC-3: every Argus import in the example is a bare argus/<subpath> specifier and the README has the build and run commands', () => {
    expect(existsSync(exampleDir), `${exampleDir} must exist`).toBe(true);
    expect(statSync(exampleDir).isDirectory()).toBe(true);

    const sources = listFiles(exampleDir).filter((f) => SOURCE_EXTENSIONS.has(extname(f)));
    expect(sources.length).toBeGreaterThan(0);

    const allSpecifiers: string[] = [];
    for (const file of sources) {
      const rel = relative(repoRoot, file);
      const found = moduleSpecifiers(readFileSync(file, 'utf8'));
      expect(
        found.literalDynamicCalls,
        `${rel}: every import()/require() call must take a string literal`,
      ).toBe(found.dynamicCalls);
      for (const spec of found.literal) {
        expect(
          spec.startsWith('node:') || ARGUS_SPECIFIER.test(spec),
          `${rel}: module specifier '${spec}' must be a node: builtin or a bare argus/<subpath>`,
        ).toBe(true);
        expect(
          /(^|\/)(src|dist)\//.test(spec),
          `${rel}: module specifier '${spec}' must not point into src/ or dist/`,
        ).toBe(false);
        allSpecifiers.push(spec);
      }
    }
    expect(allSpecifiers).toContain('argus/agent');

    const readme = join(exampleDir, 'README.md');
    expect(existsSync(readme), `${readme} must exist`).toBe(true);
    const readmeText = readFileSync(readme, 'utf8');
    expect(readmeText).toContain('npm run build');
    expect(readmeText).toContain('node examples/worker-pool/index.mjs');
  });
});
