// Package hygiene gate. Run after `npm run build`: node scripts/check-package.mts
//
// It asks npm what the published tarball would contain (`npm pack --dry-run --json`, without the
// prepack rebuild, so it inspects the dist/ that is already built) and fails when:
//   - a file outside dist/ ships, other than package.json, README.md and LICENSE (repo tooling such
//     as pharn/ or .claude/, or src/, would land in every user's node_modules);
//   - a test file or test fixture ships (*.test.*, *.spec.*, fixtures/, test-task.worker.*);
//   - a TypeScript source ships (.ts/.mts/.cts that is not a .d.ts declaration);
//   - a source map ships without the sources it points at (every map needs sourcesContent: the
//     src/ directory its `sources` name is not published);
//   - a path named in package.json "exports" is missing from the tarball, or dist/ is not built.
// It also checks that the `engines.node` floor and `.nvmrc` name the same exact version, because
// the required CI gates run on `.nvmrc`: if the two drift apart, the floor users are promised is
// no longer the version CI tests.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageJson {
  engines?: { node?: string };
  exports?: unknown;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const problems: string[] = [];

const ALLOWED_OUTSIDE_DIST = new Set(['package.json', 'README.md', 'LICENSE']);
const TEST_FILE =
  /(^|\/)(__tests__|fixtures?)\/|\.(test|spec)\.[cm]?[jt]s(\.map)?$|test-task\.worker\./;
const TS_SOURCE = /\.[cm]?ts$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// npm prints the pack listing as a JSON array with one entry per package; each entry has `files`.
function packedPaths(): string[] {
  // When run through `npm run`, npm_execpath is npm's own CLI script: running it with this Node
  // avoids resolving an `npm` shim (which on Windows needs a shell). Otherwise use npm from PATH.
  const npmCli = process.env['npm_execpath'];
  const [command, prefix] =
    npmCli !== undefined && /\.c?js$/.test(npmCli)
      ? [process.execPath, [npmCli]]
      : ['npm', [] as string[]];
  const stdout = execFileSync(
    command,
    [...prefix, 'pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error('npm pack --json did not return exactly one package entry');
  }
  const files = parsed[0]['files'];
  if (!Array.isArray(files)) throw new Error('npm pack --json entry has no files array');
  return files.map((file: unknown) => {
    if (!isRecord(file) || typeof file['path'] !== 'string') {
      throw new Error('npm pack --json listed a file without a path');
    }
    return file['path'];
  });
}

// Every string leaf of the "exports" map, as a package-relative path.
function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value.replace(/^\.\//, '')];
  if (isRecord(value)) return Object.values(value).flatMap(exportTargets);
  return [];
}

function checkSourceMap(path: string): void {
  let map: unknown;
  try {
    map = JSON.parse(readFileSync(join(root, path), 'utf8'));
  } catch (error) {
    problems.push(`${path}: cannot read source map (${describe(error)})`);
    return;
  }
  if (!isRecord(map) || !Array.isArray(map['sources'])) {
    problems.push(`${path}: not a source map (no sources array)`);
    return;
  }
  const content = map['sourcesContent'];
  const complete =
    Array.isArray(content) &&
    content.length === map['sources'].length &&
    content.every((entry: unknown) => typeof entry === 'string');
  if (!complete) {
    problems.push(`${path}: map points at sources that do not ship and has no sourcesContent`);
  }
}

function checkTarball(pkg: PackageJson): number {
  const paths = packedPaths();
  const shipped = new Set(paths);

  if (
    !paths.some((p) => p.startsWith('dist/esm/')) ||
    !paths.some((p) => p.startsWith('dist/cjs/'))
  ) {
    problems.push('dist/esm or dist/cjs is missing from the tarball: run `npm run build` first');
  }
  for (const path of paths) {
    if (!path.startsWith('dist/') && !ALLOWED_OUTSIDE_DIST.has(path)) {
      problems.push(`${path}: ships outside dist/`);
    }
    if (TEST_FILE.test(path)) problems.push(`${path}: test file or fixture ships`);
    if (TS_SOURCE.test(path) && !DECLARATION.test(path)) {
      problems.push(`${path}: TypeScript source ships`);
    }
    if (path.endsWith('.map')) checkSourceMap(path);
  }
  for (const target of new Set(exportTargets(pkg.exports))) {
    if (!shipped.has(target)) problems.push(`${target}: named in "exports" but not in the tarball`);
  }
  return paths.length;
}

function checkNodeFloor(pkg: PackageJson): void {
  const range = pkg.engines?.node ?? '';
  const floor = /^>=\s*(\S+)$/.exec(range)?.[1];
  const nvmrc = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  if (floor === undefined || !EXACT_VERSION.test(floor)) {
    problems.push(`engines.node is "${range}": it must be ">=X.Y.Z", the exact floor CI tests`);
  } else if (nvmrc !== floor) {
    problems.push(
      `.nvmrc is "${nvmrc}" but engines.node floor is "${floor}": CI must run the floor`,
    );
  }
}

let fileCount = 0;
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
  fileCount = checkTarball(pkg);
  checkNodeFloor(pkg);
} catch (error) {
  problems.push(`package check could not run: ${describe(error)}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`ok   ${fileCount} files in the tarball; engines floor matches .nvmrc`);
}
