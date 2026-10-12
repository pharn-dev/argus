import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// AC-1: `node scripts/release-notes.mjs <version> <file>` prints one version's CHANGELOG section.
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

let dir = '';
let counter = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'phargus-release-notes-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function changelog(text: string): string {
  counter += 1;
  const file = join(dir, `CHANGELOG-${counter}.md`);
  writeFileSync(file, text);
  return file;
}

function run(version: string, file: string) {
  return spawnSync(process.execPath, ['scripts/release-notes.mjs', version, file], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function expectRefusal(result: ReturnType<typeof run>) {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  const stderr = result.stderr.trimEnd();
  expect(stderr).not.toBe('');
  expect(stderr).not.toContain('\n');
  expect(stderr).toMatch(/^release-notes: \S/);
}

const withNextHeading = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.2.3] - 2026-01-01',
  '',
  '### Added',
  '',
  '- thing one',
  '- thing two',
  '',
  '## [1.2.2] - 2025-12-01',
  '',
  '- older entry',
  '',
].join('\n');

describe('scripts/release-notes.mjs', () => {
  it('AC-1: prints the section body and exits 0 when another version heading follows', () => {
    const result = run('1.2.3', changelog(withNextHeading));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('### Added\n\n- thing one\n- thing two\n');
  });

  it('AC-1: stops the body at the link-reference block', () => {
    const text = [
      '# Changelog',
      '',
      '## [1.2.3] - 2026-01-01',
      '',
      '- only entry',
      '',
      '[1.2.3]: https://example.com/releases/1.2.3',
      '',
    ].join('\n');
    const result = run('1.2.3', changelog(text));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('- only entry\n');
  });

  it('AC-1: refuses a malformed version with one stderr line and no stdout', () => {
    const file = changelog(withNextHeading);
    for (const version of ['1.2', 'v1.2.3', '01.2.3', '1.2.3-rc.1', '1.2.3\n', '']) {
      expectRefusal(run(version, file));
    }
  });

  it('AC-1: never matches a version containing RegExp metacharacters as a pattern', () => {
    const file = changelog(withNextHeading);
    for (const version of ['1.2.3|1.2.2', '1.*.3', '(1.2.3)', '1.2.[0-9]']) {
      expectRefusal(run(version, file));
    }
  });

  it('AC-1: refuses an absent heading with one stderr line and no stdout', () => {
    // `.` in the version is compared literally: `1x2x3` is not `1.2.3`.
    const text = [
      '## [1x2x3] - 2026-01-01',
      '',
      '- looks similar',
      '',
      '## [1.2.4] - 2026-02-01',
      '',
      '- other version',
      '',
    ].join('\n');
    expectRefusal(run('1.2.3', changelog(text)));
  });

  it('AC-1: refuses a repeated heading with one stderr line and no stdout', () => {
    const text = [
      '## [1.2.3] - 2026-01-01',
      '',
      '- first',
      '',
      '## [1.2.3] - 2026-01-02',
      '',
      '- second',
      '',
    ].join('\n');
    expectRefusal(run('1.2.3', changelog(text)));
  });

  it('AC-1: refuses an empty body with one stderr line and no stdout', () => {
    const text = [
      '## [1.2.3] - 2026-01-01',
      '',
      '',
      '## [1.2.2] - 2025-12-01',
      '',
      '- older entry',
      '',
    ].join('\n');
    expectRefusal(run('1.2.3', changelog(text)));
  });
});
