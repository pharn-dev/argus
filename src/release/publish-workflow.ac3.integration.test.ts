import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// AC-3: `node scripts/check-publish-workflow.mjs [<workflow.yml>]` pins the committed publish
// workflow, including executing its gate decision step against a stub `git`.
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const committed = readFileSync(join(repoRoot, '.github/workflows/publish.yml'), 'utf8');

let dir = '';
let counter = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'phargus-publish-workflow-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function check(args: string[]) {
  return spawnSync(process.execPath, ['scripts/check-publish-workflow.mjs', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 90_000,
  });
}

function checkText(text: string) {
  counter += 1;
  const file = join(dir, `publish-${counter}.yml`);
  writeFileSync(file, text);
  return check([file]);
}

// Returns `text` with `edit` applied to the slice of the file from `start` up to (not including)
// `end`, and fails the test if the edit changed nothing: a mutation that does not apply would make
// the "check fails" assertion vacuous.
function mutateJob(
  text: string,
  start: string,
  end: string | null,
  edit: (slice: string) => string,
): string {
  const from = text.indexOf(start);
  expect(from, `job marker ${JSON.stringify(start)} present`).toBeGreaterThan(-1);
  const to = end === null ? text.length : text.indexOf(end, from + 1);
  expect(to, `job end marker ${JSON.stringify(end)} present`).toBeGreaterThan(from);
  const slice = text.slice(from, to);
  const edited = edit(slice);
  expect(edited, 'mutation changed the workflow').not.toBe(slice);
  return text.slice(0, from) + edited + text.slice(to);
}

function expectRejected(mutated: string) {
  // The control first: the unmutated text is accepted, so the failure below is the mutation's.
  const control = checkText(committed);
  expect(control.status).toBe(0);
  expect(control.stderr).toBe('');

  const result = checkText(mutated);
  expect(result.status).toBe(1);
  const lines = result.stderr.trimEnd().split('\n');
  expect(lines.join('')).not.toBe('');
  for (const line of lines) {
    expect(line).toMatch(/^check-publish-workflow: \S/);
  }
}

describe('scripts/check-publish-workflow.mjs', () => {
  it('AC-3: accepts the committed .github/workflows/publish.yml', () => {
    const result = check([]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^ok /);
  });

  it('AC-3: rejects an added pull_request trigger', () => {
    const mutated = committed.replace(/^on:\n/m, 'on:\n  pull_request:\n');
    expect(mutated).not.toBe(committed);
    expectRejected(mutated);
  });

  it('AC-3: rejects cancel-in-progress set to true', () => {
    const mutated = committed.replace(/cancel-in-progress: false/, 'cancel-in-progress: true');
    expect(mutated).not.toBe(committed);
    expectRejected(mutated);
  });

  it('AC-3: rejects id-token: write added to the build job', () => {
    const mutated = mutateJob(committed, '\n  build:\n', '\n  publish:\n', (s) =>
      s.replace('\n  build:\n', '\n  build:\n    permissions:\n      id-token: write\n'),
    );
    expectRejected(mutated);
  });

  it('AC-3: rejects contents: write added to the publish job', () => {
    const mutated = mutateJob(committed, '\n  publish:\n', '\n  release:\n', (s) =>
      s.replace(/contents: read/, 'contents: write'),
    );
    expectRejected(mutated);
  });

  it("AC-3: rejects a release job whose if: lacks the NPM_PUBLISH_ENABLED == 'true' clause", () => {
    const mutated = mutateJob(committed, '\n  release:\n', null, (s) =>
      s.replace(/\s*&&\s*vars\.NPM_PUBLISH_ENABLED == 'true'/, ''),
    );
    expectRejected(mutated);
  });

  it('AC-3: rejects a gate decide step whose exit-2 case no longer releases (shown by executing it)', () => {
    const mutated = mutateJob(committed, '\n  gate:\n', '\n  build:\n', (s) =>
      s.replace(/(\n\s*2\)\s*)RELEASE=true/, '$1RELEASE=false'),
    );
    expectRejected(mutated);
  });
});
