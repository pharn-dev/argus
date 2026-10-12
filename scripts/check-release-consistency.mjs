// Fail when package.json, package-lock.json and CHANGELOG.md disagree about the release version.
//
//   node scripts/check-release-consistency.mjs [--root <dir>]
//
// Run by `npm test` on every PR (src/release/release-consistency.ac2.integration.test.ts). Releases
// publish on merge (publish.yml): a PR that bumps `version` IS the release, so a bump that forgot
// the lockfile or its CHANGELOG section must fail before the merge, not in the post-merge release.
// Whether a PR SHOULD bump, and to which level, stays the author's and reviewer's call.
//
// Asserts, for the files under <root> (default: the repository root):
//   - package.json `version` is a plain X.Y.Z;
//   - package-lock.json root `version` and `packages[""].version` equal it;
//   - CHANGELOG.md has a non-empty `## [X.Y.Z]` section for it.
// Every failed assertion is one stderr line `check-release-consistency: <reason>`; any failure exits 1
// with nothing on stdout. Green prints one `ok` line and exits 0. Bad usage is one stderr line, exit 2.
// Node core only.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogSection, VERSION_RE } from './changelog-section.mjs';

function usage(message) {
  console.error(`check-release-consistency: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (args.length === 2 && args[0] === '--root') {
  root = resolve(args[1]);
} else if (args.length !== 0) {
  usage('usage: node scripts/check-release-consistency.mjs [--root <dir>]');
}

const failures = [];
const fail = (reason) => failures.push(String(reason).replace(/\s*[\r\n]+\s*/g, ' '));

function readText(name) {
  try {
    return readFileSync(join(root, name), 'utf8');
  } catch (error) {
    fail(`cannot read ${name}: ${error && (error.code ?? error.message)}`);
    return undefined;
  }
}

function readJson(name) {
  const text = readText(name);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${name} is not valid JSON: ${error && error.message}`);
    return undefined;
  }
}

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const changelog = readText('CHANGELOG.md');

const version = pkg && typeof pkg.version === 'string' ? pkg.version : undefined;
if (pkg !== undefined && version === undefined) fail('package.json has no string `version`');
if (version !== undefined && !VERSION_RE.test(version)) {
  fail(`package.json version ${JSON.stringify(version)} is not a plain X.Y.Z`);
}

if (version !== undefined && lock !== undefined) {
  if (lock.version !== version) {
    fail(
      `package-lock.json version ${JSON.stringify(lock.version ?? null)} != package.json ${version}`,
    );
  }
  const rootPackage = lock.packages?.[''];
  if (!rootPackage || rootPackage.version !== version) {
    fail(
      `package-lock.json packages[""].version ${JSON.stringify(rootPackage?.version ?? null)} != package.json ${version}`,
    );
  }
}

if (version !== undefined && VERSION_RE.test(version) && changelog !== undefined) {
  const section = changelogSection(changelog, version);
  if (!section.ok) fail(`CHANGELOG.md: ${section.error} (version ${version})`);
}

if (failures.length > 0) {
  for (const reason of failures) console.error(`check-release-consistency: ${reason}`);
  process.exit(1);
}
console.log(
  `ok   release ${version} is consistent (package.json, package-lock.json, CHANGELOG.md)`,
);
