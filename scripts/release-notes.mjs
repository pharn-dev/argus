// Print one version's section of CHANGELOG.md — the GitHub Release notes.
//
//   node scripts/release-notes.mjs <X.Y.Z> [CHANGELOG.md]
//
// Run by publish.yml's unprivileged `build` job (before `npm ci`), so a version bump without its
// CHANGELOG section fails before any dependency is installed. The extraction rules live in
// scripts/changelog-section.mjs. Exit 1, with exactly one line `release-notes: <reason>` on stderr
// and nothing on stdout, when the arguments are wrong, the file cannot be read, the version is
// malformed, the heading is absent or repeated, or the body is empty. Node core only.
import { readFileSync } from 'node:fs';
import { changelogSection } from './changelog-section.mjs';

function fail(message) {
  console.error(`release-notes: ${String(message).replace(/\s*[\r\n]+\s*/g, ' ')}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2) {
  fail('usage: node scripts/release-notes.mjs <X.Y.Z> [CHANGELOG.md]');
}
const [version, file = 'CHANGELOG.md'] = args;

let text;
try {
  text = readFileSync(file, 'utf8');
} catch (error) {
  fail(`cannot read ${file}: ${error && (error.code ?? error.message)}`);
}

const section = changelogSection(text, version);
if (!section.ok) fail(section.error);
process.stdout.write(`${section.notes}\n`);
