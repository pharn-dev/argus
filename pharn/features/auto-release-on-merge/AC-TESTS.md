---
spec_id: auto-release-on-merge
spec_content_hash: 1ee5d88ae90de129442872ff2317020b40a5fe3015c11007b6ab95ecb2522715
---

## Files

- `src/release/release-notes.ac1.integration.test.ts` — the tests for AC-1
- `src/release/release-consistency.ac2.integration.test.ts` — the tests for AC-2
- `src/release/publish-workflow.ac3.integration.test.ts` — the tests for AC-3

## Mapping

- AC-1 | integration | `src/release/release-notes.ac1.integration.test.ts` | CLI `node scripts/release-notes.mjs <version> <file>` spawned via node:child_process spawnSync with process.execPath (encoding utf8, a timeout), cwd = repo root (resolved from import.meta.url), against CHANGELOG fixtures written to a fresh os.tmpdir() mkdtemp dir removed in afterAll; observed: for `1.2.3` with exactly one `## [1.2.3] - 2026-01-01` heading whose body is followed by a `## [1.2.2]` heading (and, in a second fixture, by a link-reference block `[1.2.3]: https://…`), exit 0 and stdout equal to that body trimmed plus one trailing newline (no text from the next section or the link block); for a malformed version (`1.2`, `v1.2.3`, `01.2.3`, `1.2.3-rc.1`), an absent heading, a repeated `## [1.2.3]` heading, and an empty body, exit 1, stdout `''`, and stderr exactly one non-empty line (stderr.trimEnd() contains no `\n`); plus a version containing RegExp metacharacters is refused as malformed, never matched as a pattern
- AC-2 | integration | `src/release/release-consistency.ac2.integration.test.ts` | CLI `node scripts/check-release-consistency.mjs [--root <dir>]` spawned via node:child_process spawnSync with process.execPath (encoding utf8, a timeout), cwd = repo root; observed: with no `--root` (the repository at HEAD) exit 0 and stderr `''`; with `--root <tmp>` where a fresh os.tmpdir() mkdtemp dir holds copies of the repo's package.json and package-lock.json whose `version` and `packages[""].version` are bumped one minor past the current package.json version, plus an unchanged copy of CHANGELOG.md (so it has no section for the bumped version), exit 1, stdout `''`, and a non-empty stderr naming the bumped version; the temp dir is removed in afterAll
- AC-3 | integration | `src/release/publish-workflow.ac3.integration.test.ts` | CLI `node scripts/check-publish-workflow.mjs [<workflow.yml>]` spawned via node:child_process spawnSync with process.execPath (encoding utf8, a timeout), cwd = repo root; observed: with no argument (the committed `.github/workflows/publish.yml`) exit 0 and stderr `''`; and, on mutated copies of the committed workflow written to a fresh os.tmpdir() mkdtemp dir (removed in afterAll) and passed as the argument, exit 1 with non-empty stderr for each of: a `pull_request` trigger added, `cancel-in-progress` set to `true`, `id-token: write` added to the `build` job, `contents: write` added to the `publish` job, the `vars.NPM_PUBLISH_ENABLED == 'true'` clause removed from the `release` job's `if:`, and the gate `decide` step's `2)` case changed to set `RELEASE=false` (so the stub-`git` execution, not only the static read, is shown to run)
