// Pin the shape of .github/workflows/publish.yml, and EXECUTE its gate decision step.
//
//   node scripts/check-publish-workflow.mjs [<workflow.yml>]
//
// Run by `npm test` (src/release/publish-workflow.ac3.integration.test.ts). publish.yml runs on every
// push to `main` and releases exactly when package.json's version has no `v<version>` tag yet; it is
// the one file that can mint an npm publish token, so its trigger, job graph, per-job permissions and
// release decision must not drift unnoticed. It only runs after a merge (no pull request executes
// it), which is why this check reads it on every PR.
//
// Structural assertions (every failure is one stderr line `check-publish-workflow: <reason>`):
//   - triggers are exactly `push` to `main` and `workflow_dispatch`;
//   - workflow-level `concurrency` with `cancel-in-progress: false`; default `permissions: contents: read`;
//   - jobs are exactly gate, build, publish, release, chained gate -> build -> publish -> release;
//   - only `publish` holds `id-token: write` and an `environment` (`npm-publish`); only `release`
//     holds `contents: write`; nothing else grants write;
//   - `publish` and `release` run only when the gate's `release` output is `true` AND the repository
//     variable `NPM_PUBLISH_ENABLED` is exactly `true`; `gate` and `build` never read that variable.
// Gate-decision execution (no network, no real git or npm): the committed `run:` text of the `gate`
// step `decide` runs under bash against a stub `git` that records its arguments and exits with
// $STUB_GIT_EXIT. `ls-remote` exit 0 -> release=false, 2 -> release=true, anything else fails; a ref
// other than refs/heads/main, or a version that is not plain X.Y.Z, fails before git is called.
// Node core only; needs `bash` (the shell GitHub runs `run:` with). A missing `decide` step, a
// missing bash or a timeout is a failure line, never a pass. Exit 1 on any failure, 2 on bad usage.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflowYaml } from './workflow-yaml.mjs';

const JOBS = ['gate', 'build', 'publish', 'release'];
const KILL_SWITCH = "vars.NPM_PUBLISH_ENABLED == 'true'";
const PUBLISH_IF = `needs.gate.outputs.release == 'true' && ${KILL_SWITCH}`;
const BUILD_IF = "needs.gate.outputs.release == 'true'";
const STEP_TIMEOUT_MS = 20_000;

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error(
    'check-publish-workflow: usage: node scripts/check-publish-workflow.mjs [<workflow.yml>]',
  );
  process.exit(2);
}
const file =
  args[0] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'publish.yml');

const failures = [];
const fail = (reason) => failures.push(String(reason).replace(/\s*[\r\n]+\s*/g, ' '));
const finish = () => {
  if (failures.length > 0) {
    for (const reason of failures) console.error(`check-publish-workflow: ${reason}`);
    process.exit(1);
  }
};

let workflow;
try {
  workflow = parseWorkflowYaml(readFileSync(file, 'utf8'));
} catch (error) {
  fail(`cannot read ${file}: ${error && error.message}`);
  finish();
}

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOf = (value) => (isMap(value) ? Object.keys(value).sort() : []);
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const asList = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

// `if:` text, whitespace-normalized, with an optional ${{ ... }} wrapper removed.
function normalizeIf(value) {
  if (typeof value !== 'string') return undefined;
  let text = value.trim().replace(/\s+/g, ' ');
  const wrapped = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(text);
  if (wrapped) text = wrapped[1];
  return text;
}

function writeGrants(permissions) {
  return isMap(permissions)
    ? Object.entries(permissions)
        .filter(([, level]) => level === 'write')
        .map(([name]) => name)
    : [];
}

function checkStructure() {
  const on = workflow.on;
  if (!sameSet(keysOf(on), ['push', 'workflow_dispatch'])) {
    fail(`triggers must be exactly push and workflow_dispatch, got [${keysOf(on).join(', ')}]`);
  } else {
    const push = on.push;
    if (
      !isMap(push) ||
      !sameSet(keysOf(push), ['branches']) ||
      JSON.stringify(push.branches) !== '["main"]'
    ) {
      fail('the push trigger must be exactly `branches: [main]`');
    }
    if (
      on.workflow_dispatch !== null &&
      !(isMap(on.workflow_dispatch) && keysOf(on.workflow_dispatch).length === 0)
    ) {
      fail('workflow_dispatch must take no inputs (recovery only)');
    }
  }

  if (!isMap(workflow.concurrency)) {
    fail('workflow-level `concurrency` is missing');
  } else if (workflow.concurrency['cancel-in-progress'] !== 'false') {
    fail('concurrency `cancel-in-progress` must be false (never cancel a run mid-release)');
  }

  if (
    !isMap(workflow.permissions) ||
    !sameSet(keysOf(workflow.permissions), ['contents']) ||
    workflow.permissions.contents !== 'read'
  ) {
    fail('workflow-level `permissions` must be exactly `contents: read`');
  }

  const jobs = workflow.jobs;
  if (!sameSet(keysOf(jobs), JOBS)) {
    fail(`jobs must be exactly ${JOBS.join(', ')}, got [${keysOf(jobs).join(', ')}]`);
    return;
  }

  const needs = Object.fromEntries(JOBS.map((name) => [name, asList(jobs[name]?.needs)]));
  if (needs.gate.length > 0) fail('`gate` must have no `needs`');
  if (!needs.build.includes('gate')) fail('`build` must need `gate`');
  for (const dependency of ['build', 'gate']) {
    if (!needs.publish.includes(dependency)) fail(`\`publish\` must need \`${dependency}\``);
  }
  for (const dependency of ['publish', 'gate']) {
    if (!needs.release.includes(dependency)) fail(`\`release\` must need \`${dependency}\``);
  }

  const expectedWrites = { gate: [], build: [], publish: ['id-token'], release: ['contents'] };
  for (const name of JOBS) {
    const job = jobs[name];
    if (!isMap(job)) {
      fail(`job \`${name}\` is not a mapping`);
      continue;
    }
    if (typeof job.permissions === 'string') {
      fail(`job \`${name}\` sets \`permissions: ${job.permissions}\`; use an explicit mapping`);
      continue;
    }
    const grants = writeGrants(job.permissions);
    if (!sameSet(grants, expectedWrites[name])) {
      fail(
        `job \`${name}\` grants write to [${grants.join(', ')}], expected [${expectedWrites[name].join(', ')}]`,
      );
    }
    const idToken = isMap(job.permissions) ? job.permissions['id-token'] : undefined;
    if (name !== 'publish' && idToken !== undefined)
      fail(`only \`publish\` may set \`id-token\`; \`${name}\` does`);
    if (name === 'publish' && idToken !== 'write') fail('`publish` must hold `id-token: write`');
    if (name === 'release' && job.permissions?.contents !== 'write')
      fail('`release` must hold `contents: write`');
  }
  if (isMap(workflow.permissions) && 'id-token' in workflow.permissions) {
    fail('the workflow level must not set `id-token`');
  }

  for (const name of JOBS) {
    const environment = isMap(jobs[name]?.environment)
      ? jobs[name].environment.name
      : jobs[name]?.environment;
    if (name === 'publish') {
      if (environment !== 'npm-publish')
        fail('`publish` must run in the `npm-publish` environment');
    } else if (jobs[name]?.environment !== undefined) {
      fail(`only \`publish\` may set an environment; \`${name}\` does`);
    }
  }

  for (const name of ['publish', 'release']) {
    const condition = normalizeIf(jobs[name]?.if);
    if (condition !== PUBLISH_IF) {
      fail(
        `\`${name}\` must run only \`if: ${PUBLISH_IF}\`, got ${JSON.stringify(condition ?? null)}`,
      );
    }
  }
  for (const name of ['gate', 'build']) {
    const condition = normalizeIf(jobs[name]?.if);
    if (condition !== undefined && condition.includes('NPM_PUBLISH_ENABLED')) {
      fail(
        `\`${name}\` must not read NPM_PUBLISH_ENABLED (the kill-switch never stops gate or build)`,
      );
    }
  }
  if (normalizeIf(jobs.build?.if) !== BUILD_IF) {
    fail(`\`build\` must run only \`if: ${BUILD_IF}\``);
  }
}

// One scenario of the gate decision step, run under bash against a stub git.
function runDecide(script, scenario) {
  const root = mkdtempSync(join(tmpdir(), 'phargus-gate-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const gitLog = join(root, 'git.log');
    const githubOutput = join(root, 'github-output');
    writeFileSync(gitLog, '');
    writeFileSync(githubOutput, '');
    writeFileSync(
      join(bin, 'git'),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$STUB_GIT_LOG"\nexit "${STUB_GIT_EXIT:-0}"\n',
    );
    chmodSync(join(bin, 'git'), 0o755);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'scenario', version: scenario.version }),
    );
    writeFileSync(join(root, 'decide.sh'), script);

    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', join(root, 'decide.sh')],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: STEP_TIMEOUT_MS,
        env: {
          PATH: [bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
          HOME: root,
          GITHUB_REF: scenario.ref,
          GITHUB_OUTPUT: githubOutput,
          STUB_GIT_LOG: gitLog,
          STUB_GIT_EXIT: String(scenario.git ?? 0),
        },
      },
    );
    return {
      result,
      output: readFileSync(githubOutput, 'utf8').split('\n').filter(Boolean),
      gitCalls: readFileSync(gitLog, 'utf8').split('\n').filter(Boolean),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function checkGateDecision() {
  const steps = workflow.jobs?.gate?.steps;
  const decide = asList(steps).find((step) => isMap(step) && step.id === 'decide');
  if (!decide || typeof decide.run !== 'string') {
    fail('the `gate` job has no step with `id: decide` and a `run:` script');
    return;
  }
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8', timeout: STEP_TIMEOUT_MS });
  if (probe.error || probe.status !== 0) {
    fail('bash is not available, so the gate decision step cannot be executed');
    return;
  }

  const main = 'refs/heads/main';
  const scenarios = [
    {
      name: 'tag exists (git 0)',
      ref: main,
      version: '0.1.0',
      git: 0,
      expect: { status: 0, release: 'false', calls: 1 },
    },
    {
      name: 'no tag (git 2)',
      ref: main,
      version: '0.1.0',
      git: 2,
      expect: { status: 0, release: 'true', calls: 1 },
    },
    {
      name: 'git cannot tell (git 128)',
      ref: main,
      version: '0.1.0',
      git: 128,
      expect: { status: 'nonzero', calls: 1 },
    },
    {
      name: 'a branch other than main',
      ref: 'refs/heads/feature',
      version: '0.1.0',
      expect: { status: 'nonzero', calls: 0 },
    },
    {
      name: 'a tag ref',
      ref: 'refs/tags/v0.1.0',
      version: '0.1.0',
      expect: { status: 'nonzero', calls: 0 },
    },
    ...['1.2', '01.2.3', '1.2.3-rc.1'].map((version) => ({
      name: `version ${version}`,
      ref: main,
      version,
      expect: { status: 'nonzero', calls: 0 },
    })),
  ];

  for (const scenario of scenarios) {
    let run;
    try {
      run = runDecide(decide.run, scenario);
    } catch (error) {
      fail(`gate decision, ${scenario.name}: could not run the step (${error && error.message})`);
      continue;
    }
    const { result, output, gitCalls } = run;
    const label = `gate decision, ${scenario.name}`;
    if (result.error || result.signal) {
      fail(`${label}: the step did not finish (${result.error?.message ?? result.signal})`);
      continue;
    }
    const wantsZero = scenario.expect.status === 0;
    if (wantsZero && result.status !== 0) fail(`${label}: expected exit 0, got ${result.status}`);
    if (!wantsZero && result.status === 0) fail(`${label}: expected a non-zero exit, got 0`);
    if (gitCalls.length !== scenario.expect.calls) {
      fail(`${label}: expected ${scenario.expect.calls} git call(s), got ${gitCalls.length}`);
    }
    if (scenario.expect.calls === 1) {
      const call = gitCalls[0] ?? '';
      if (!call.includes('ls-remote') || !call.includes(`refs/tags/v${scenario.version}`)) {
        fail(
          `${label}: expected a \`git ls-remote\` of refs/tags/v${scenario.version}, got ${JSON.stringify(call)}`,
        );
      }
    }
    if (wantsZero) {
      if (!output.includes(`release=${scenario.expect.release}`))
        fail(`${label}: expected release=${scenario.expect.release}`);
      if (!output.includes(`version=${scenario.version}`))
        fail(`${label}: expected version=${scenario.version}`);
    } else if (output.some((line) => line.startsWith('release='))) {
      fail(`${label}: wrote a release= output although it must fail`);
    }
  }
}

if (!isMap(workflow)) {
  fail('the workflow is not a mapping');
} else {
  checkStructure();
  checkGateDecision();
}

finish();
console.log(
  'ok   publish workflow: triggers, job graph, permissions, kill-switch and gate decision match',
);
