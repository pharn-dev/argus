import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// AC-2: `node scripts/check-release-consistency.mjs [--root <dir>]` is green at HEAD and red for a
// version that package.json and the lockfile carry but CHANGELOG.md has no section for.
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

interface PackageJson {
  version: string;
  [key: string]: unknown;
}
interface LockJson {
  version: string;
  packages: Record<string, { version?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as LockJson;

const [major, minor] = pkg.version.split('.').map(Number);
const bumped = `${major}.${(minor ?? 0) + 1}.0`;

let dir = '';
let counter = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'phargus-release-consistency-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]) {
  return spawnSync(process.execPath, ['scripts/check-release-consistency.mjs', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

// A scratch root holding copies of the repo's three release files, with the version edits applied.
function scratchRoot(edit: { pkgVersion: string; lockVersion: string }) {
  counter += 1;
  const root = join(dir, `root-${counter}`);
  mkdirSync(root);
  const nextPkg: PackageJson = { ...pkg, version: edit.pkgVersion };
  const nextLock: LockJson = {
    ...lock,
    version: edit.lockVersion,
    packages: {
      ...lock.packages,
      '': { ...lock.packages[''], version: edit.lockVersion },
    },
  };
  writeFileSync(join(root, 'package.json'), JSON.stringify(nextPkg, null, 2));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(nextLock, null, 2));
  copyFileSync(join(repoRoot, 'CHANGELOG.md'), join(root, 'CHANGELOG.md'));
  return root;
}

function expectFailure(result: ReturnType<typeof run>, mention: string) {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  const lines = result.stderr.trimEnd().split('\n');
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).toMatch(/^check-release-consistency: \S/);
  }
  expect(result.stderr).toContain(mention);
}

describe('scripts/check-release-consistency.mjs', () => {
  it('AC-2: passes for the repository at HEAD', () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(pkg.version);
  });

  it('AC-2: passes for an unbumped scratch copy (the control for the failures below)', () => {
    const root = scratchRoot({
      pkgVersion: pkg.version,
      lockVersion: pkg.version,
    });
    const result = run(['--root', root]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('AC-2: fails for a bumped version that has no CHANGELOG section', () => {
    const root = scratchRoot({ pkgVersion: bumped, lockVersion: bumped });
    expectFailure(run(['--root', root]), bumped);
  });

  it('AC-2: fails when package-lock.json carries another version than package.json', () => {
    const root = scratchRoot({
      pkgVersion: pkg.version,
      lockVersion: bumped,
    });
    expectFailure(run(['--root', root]), 'package-lock.json');
  });
});
