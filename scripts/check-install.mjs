// Checks a prebuilt tarball as a consumer, never through repository self-resolution.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tarball = process.argv[2];
assert.ok(tarball && process.argv.length === 3, 'usage: npm run check:install -- <tarball.tgz>');
const archive = await realpath(resolve(tarball));
assert.ok((await stat(archive)).isFile() && archive.endsWith('.tgz'), 'expected a .tgz file');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const expected = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const consumer = await mkdtemp(join(tmpdir(), 'phargus-installed-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith('PHARGUS_') && !['NODE_PATH', 'NODE_OPTIONS'].includes(name),
  ),
);
env.PHARGUS_ENABLED = 'false';
// Native install scripts must use the same Node ABI as the smoke process, including when the
// caller selected Node by absolute path rather than changing PATH.
env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH ?? ''}`;
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli?.endsWith('.js') ? process.execPath : 'npm';
const npmPrefix = npmCli?.endsWith('.js') ? [npmCli] : [];

function run(command, args, timeoutMs = 30000) {
  return new Promise((resolveRun, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { cwd: consumer, env, stdio: 'inherit', detached: grouped });
    let timedOut = false;
    const kill = () => {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') reject(error);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      // A failed smoke process may have left a sandbox child running.
      if (code !== 0) kill();
      if (code === 0 && !timedOut) resolveRun();
      else reject(new Error(`${command} failed (${timedOut ? 'timeout' : (signal ?? code)})`));
    });
  });
}
const npm = (args) => run(npmCommand, [...npmPrefix, ...args], 300000);

try {
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'phargus-consumer', private: true }),
  );
  await npm(['install', archive, '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund']);
  const installed = JSON.parse(
    await readFile(join(consumer, 'node_modules', expected.name, 'package.json'), 'utf8'),
  );
  assert.equal(installed.name, expected.name);
  assert.equal(installed.version, expected.version);
  assert.deepEqual(installed.exports, expected.exports);
  await copyFile(new URL('./install-smoke.mjs', import.meta.url), join(consumer, 'smoke.mjs'));
  for (const format of ['import', 'require'])
    await run(process.execPath, ['smoke.mjs', format, 'core']);
  // The bin must resolve and run from the installed tarball (npx phargus), not from the repo.
  await npm(['exec', '--no', '--', 'phargus', '--help']);
  console.log('ok   installed bin (npx phargus --help)');

  // Tooling is pinned to the lockfile and installed in the consumer; type resolution cannot fall
  // back to the repo's sources, aliases or node_modules.
  const version = (name) => lock.packages[`node_modules/${name}`].version;
  await npm([
    'install',
    '--save-dev',
    '--no-audit',
    '--no-fund',
    `typescript@${version('typescript')}`,
    `@types/node@${version('@types/node')}`,
    `isolated-vm@${version('isolated-vm')}`,
  ]);
  const imports = Object.keys(expected.exports)
    .filter((key) => key !== './package.json')
    .map(
      (key, index) =>
        `import * as module${index} from '${expected.name}${key.slice(1)}';\nvoid module${index};`,
    )
    .join('\n');
  const types = `${imports}\nimport type { AgentSample } from '${expected.name}/agent';
import type { AggregatedWindow } from '${expected.name}/collector';
import type { HeapSnapshotSummary } from '${expected.name}/analyzer';
import type { DashboardServerOptions } from '${expected.name}/dashboard';
import type { PluginRunnerOptions } from '${expected.name}/plugin-runner';
import type * as Otel from '${expected.name}/otel';
export type ConsumerTypes = [AgentSample, AggregatedWindow, HeapSnapshotSummary, DashboardServerOptions, PluginRunnerOptions, typeof Otel];\n`;
  for (const extension of ['mts', 'cts'])
    await writeFile(join(consumer, `consumer.${extension}`), types);
  await run(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '--noEmit',
    '--strict',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    '--types',
    'node',
    'consumer.mts',
    'consumer.cts',
  ]);
  console.log('ok   installed declarations (strict NodeNext, ESM + CJS)');
  for (const format of ['import', 'require'])
    await run(process.execPath, ['smoke.mjs', format, 'plugins']);
} finally {
  await rm(consumer, { recursive: true, force: true });
}
