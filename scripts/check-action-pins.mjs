// Fails if any GitHub Actions workflow uses a third-party action that is not pinned to a full
// 40-character commit SHA. A tag such as @v4 can be moved to point at different code; a SHA cannot.
// Local actions (./...) are fine. Run from the repo root: node scripts/check-action-pins.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dirs = ['.github/workflows', '.github/actions'];
const SHA = /^[0-9a-f]{40}$/;
const bad = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.ya?ml$/.test(entry.name) ? [path] : [];
  });
}

for (const file of dirs.flatMap(walk)) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      const match = /^\s*(?:-\s*)?uses:\s*['"]?([^\s'"#]+)/.exec(line);
      if (!match) return;
      const ref = match[1];
      if (ref.startsWith('./')) return;
      const at = ref.lastIndexOf('@');
      if (at === -1 || !SHA.test(ref.slice(at + 1))) bad.push(`${file}:${index + 1}  ${ref}`);
    });
}

if (bad.length > 0) {
  console.error(
    'Actions must be pinned to a full commit SHA (add the version as a trailing comment):',
  );
  for (const entry of bad) console.error(`  ${entry}`);
  process.exit(1);
}
console.log('ok   every workflow action is pinned to a commit SHA');
