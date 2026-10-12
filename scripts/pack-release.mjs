// Pack the already checked build once and record the identity of that exact artifact.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const destination = resolve(process.argv[2] ?? '');
if (process.argv.length !== 3) throw new Error('usage: node scripts/pack-release.mjs <directory>');
mkdirSync(destination, { recursive: true });
const npmCli = process.env.npm_execpath;
const command = npmCli?.endsWith('.js') ? process.execPath : 'npm';
const prefix = npmCli?.endsWith('.js') ? [npmCli] : [];
const packed = JSON.parse(
  execFileSync(
    command,
    [...prefix, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: root, encoding: 'utf8' },
  ),
);
if (packed.length !== 1 || !/^[A-Za-z0-9._-]+\.tgz$/.test(packed[0].filename)) {
  throw new Error('unexpected npm pack output');
}
const { filename, version } = packed[0];
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sha256 = createHash('sha256')
  .update(readFileSync(join(destination, filename)))
  .digest('hex');
const metadata = { filename, version, commit, sha256 };
writeFileSync(join(destination, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${filename}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Prepared npm artifact\n\n- Version: ${version}\n- Commit: ${commit}\n- Tarball: ${filename}\n- SHA-256: ${sha256}\n\nPublishing requires a GitHub Release and repository variable \`NPM_PUBLISH_ENABLED=true\`. Manual preparation never publishes.\n`,
  );
}
