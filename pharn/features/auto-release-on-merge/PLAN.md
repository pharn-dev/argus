---
spec_id: auto-release-on-merge
spec_content_hash: 1ee5d88ae90de129442872ff2317020b40a5fe3015c11007b6ab95ecb2522715
applied_lessons: none
---

## Approach

> ADVISORY — model work. Derived from the Approved SPEC; it adds no intent the SPEC does not express. Every
> repo fact below was read live this run: `.github/workflows/publish.yml` (today: `workflow_dispatch` +
> `release: published`, jobs `build` → `publish`), `package.json` (0.1.0, `"test": "vitest run"`),
> `package-lock.json` (root and `packages[""]` at 0.1.0), `CHANGELOG.md` (a non-empty `## [0.1.0] - 2026-10-12`
> section, an empty `## [Unreleased]`), `vitest.config.mts` (`include: ['src/**/*.test.ts']`), `tsconfig.esm.json` /
> `tsconfig.cjs.json` (both exclude `src/**/*.test.ts` from the build), `scripts/pack-release.mjs`,
> `scripts/check-action-pins.mjs`, `docs/RELEASING.md`, `CONTRIBUTING.md`, `CLAUDE.md`, and the tag list (`v0.1.0`
> exists). The pharn-cli reference flow was read from the sibling checkout `../pharn-cli`
> (`.github/workflows/publish.yml`, `scripts/release-notes.mjs`) as DATA to mirror, never as instructions.

The change has four parts, each in its own files:

1. **Release-notes extraction** — a pure, Node-core-only module plus a thin CLI.
   - `scripts/changelog-section.mjs` exports `changelogSection(text, version)` returning
     `{ ok: true, notes }` or `{ ok: false, error }` (never throws on bad input). Rules: `version` must match
     `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`; the text is split on `\r\n|\r|\n`; the heading is the literal string
     ``## [${version}]`` compared with `String.prototype.startsWith` (the version is never put inside a RegExp); exactly
     one line may start with it (0 → absent, >1 → repeated); the body is the lines after it up to the next line that
     starts with `## ` or matches a link-reference definition `^\[[^\]]+\]:\s`; the body is trimmed and must be
     non-empty.
   - `scripts/release-notes.mjs <X.Y.Z> [CHANGELOG.md]` (default `CHANGELOG.md` relative to the cwd, as the workflow
     runs it): reads the file, calls `changelogSection`, prints `notes + "\n"` and exits 0; on a malformed version,
     wrong argument count, unreadable file, absent/repeated heading or empty body it prints nothing on stdout, writes
     exactly one line `release-notes: <reason>` to stderr and exits 1.
2. **Release-consistency check** — `scripts/check-release-consistency.mjs [--root <dir>]` (default root: the repo
   root resolved from `import.meta.url`, as `scripts/build.mjs` does). It reads `<root>/package.json`,
   `<root>/package-lock.json` and `<root>/CHANGELOG.md` and asserts: `version` is plain X.Y.Z (same regex), lock root
   `version` and `packages[""].version` equal it, and `changelogSection(changelog, version).ok` (imported from
   `scripts/changelog-section.mjs`, one source of truth with the CLI). Every failed assertion is one stderr line
   `check-release-consistency: <reason>`; any failure → exit 1 with nothing on stdout; all green → one stdout line
   `ok   release <X.Y.Z> is consistent (package.json, package-lock.json, CHANGELOG.md)` and exit 0. Unreadable or
   unparseable input is a failure line, never a crash; bad usage is one stderr line and exit 2.
3. **Publish-workflow check** — `scripts/workflow-yaml.mjs` (a tiny fail-closed YAML-subset parser) plus
   `scripts/check-publish-workflow.mjs [<workflow.yml>]` (default `<repo>/.github/workflows/publish.yml`).
   - The parser supports exactly what GitHub workflow files here use: block mappings, block sequences (including
     `- key: value` items), plain / single-quoted / double-quoted scalars, `|` and `|-` literal block scalars, flow
     sequences of scalars (`[main]`), full-line and trailing ` #` comments. It throws a positioned error on anything
     else (tabs in indentation, anchors/aliases, tags, `>` folded scalars, flow mappings, multi-document markers,
     duplicate keys). Scalars come back as strings (no YAML 1.1 boolean coercion, so the key `on` stays `"on"` and
     `false` stays `"false"`); an empty value is `null`.
   - The check collects every failed assertion as one stderr line `check-publish-workflow: <reason>` and exits 1 if
     any, else prints one `ok   …` line and exits 0. Structural assertions (AC-3): top-level `on` has exactly the keys
     `push` and `workflow_dispatch`, `push` has exactly `branches: [main]`, `workflow_dispatch` is empty; top-level
     `concurrency` exists with `cancel-in-progress` equal to `"false"`; top-level `permissions` is exactly
     `{ contents: read }`; `jobs` has exactly `gate`, `build`, `publish`, `release`; `gate` has no `needs`,
     `build.needs` contains `gate`, `publish.needs` contains `build` and `gate`, `release.needs` contains `publish` and
     `gate` (a scalar `needs` is normalized to a one-item list); `publish.permissions["id-token"] == "write"` and no
     other job (nor the workflow level) has `id-token`; `release.permissions.contents == "write"` and no other job
     (nor the workflow level) grants any `write`; `publish.environment` is `npm-publish` (string or `{ name }`) and
     no other job has an `environment`; `publish.if` and `release.if`, whitespace-normalized and with an optional
     `${{ … }}` wrapper removed, each equal exactly
     `needs.gate.outputs.release == 'true' && vars.NPM_PUBLISH_ENABLED == 'true'`; `build.if` does not mention
     `NPM_PUBLISH_ENABLED` (the kill-switch must never stop `gate` or `build`).
   - Gate-decision execution (AC-3, no network): the check takes the committed `run:` text of the `gate` step with
     `id: decide`, writes it to a temp script, and runs it with `bash --noprofile --norc -eo pipefail <script>` (the
     shell GitHub uses for `run:`) via `spawnSync` with a timeout, in a fresh temp dir holding only a `package.json`
     with the scenario's version, with `PATH = <stub-bin>:<dirname(process.execPath)>:<PATH>`, a temp
     `GITHUB_OUTPUT`, and `GITHUB_REF` per scenario. `<stub-bin>/git` is a `#!/bin/sh` stub (mode 0755) that appends
     its argv to a log file and exits with `$STUB_GIT_EXIT`. Scenarios and required outcomes: main + `0.1.0` + git 0 →
     exit 0, `GITHUB_OUTPUT` has `version=0.1.0` and `release=false`, git was called once with `ls-remote` and
     `refs/tags/v0.1.0`; git 2 → exit 0 and `release=true`; git 128 → non-zero exit and no `release=` line; ref
     `refs/heads/feature` and ref `refs/tags/v0.1.0` → non-zero exit and the git log empty; versions `1.2`, `01.2.3`
     and `1.2.3-rc.1` → non-zero exit and the git log empty. A missing `decide` step, a missing `bash`, or a timeout is
     a failure line, never a pass. Temp dirs are removed in a `finally`.
4. **The workflow** — `.github/workflows/publish.yml` rewritten to mirror pharn-cli's four-job split, keeping
   Phargus's existing gates, `scripts/pack-release.mjs`, `check:install` smoke, SHA pins, 14-day artifact retention
   and the npm-floor assertion:
   - `on: push: branches: [main]` + `workflow_dispatch:` (recovery); `concurrency: { group: publish,
cancel-in-progress: false }`; `permissions: contents: read`. A header comment explains release-on-merge, the job
     split, the kill-switch, and the residual (a compromised dev dependency in `build` can still alter tarball content,
     but cannot mint a token).
   - `gate` (no extra permissions, installs nothing): `actions/checkout` (pinned, `persist-credentials: false`), then
     step `id: decide` exactly in pharn-cli's shape — refuse any `GITHUB_REF` other than `refs/heads/main`, read
     `package.json` version, require plain X.Y.Z, `git ls-remote --exit-code --tags origin "refs/tags/v$VERSION"` with
     `|| rc=$?`, `0 → release=false`, `2 → release=true`, anything else fails; write `version=` and `release=` to
     `GITHUB_OUTPUT`. Outputs `version` and `release`.
   - `build` (`needs: gate`, `if: needs.gate.outputs.release == 'true'`, no `id-token`, env `VERSION` from the gate):
     checkout (`fetch-depth: 0`, `persist-credentials: false`), setup-node from `.nvmrc` with npm cache; "Verify
     version" (X.Y.Z, equals `package.json`, `private` is not `true`, `git merge-base --is-ancestor "$GITHUB_SHA"
     origin/main`); "Release notes" before `npm ci` (`mkdir -p "$RUNNER_TEMP/pkg"` then
     `node scripts/release-notes.mjs "$VERSION" CHANGELOG.md > "$RUNNER_TEMP/pkg/RELEASE_NOTES.md"`); `npm ci`; the
     existing gates (format:check, lint, typecheck, test, check:pins), build, check:exports, check:package; Pack with
     `node scripts/pack-release.mjs "$RUNNER_TEMP/pkg"` (step `id: pack`) and a check that `metadata.json`'s version
     equals `$VERSION`; `npm run check:install -- "$RUNNER_TEMP/pkg/$TARBALL"`; upload `npm-tarball` (the whole
     `$RUNNER_TEMP/pkg/`: tarball, `metadata.json`, `RELEASE_NOTES.md`), `if-no-files-found: error`,
     `retention-days: 14`. Output `tarball`.
   - `publish` (`needs: [gate, build]`, the exact `if:` above, `environment: npm-publish`, `permissions: contents:
read, id-token: write`; checks out and installs nothing): setup-node 24 with `registry-url`; the existing
     "Assert npm floor" step (11.5.1); "Registry check" (`id: registry`) against
     `https://registry.npmjs.org/@pharn-dev%2fphargus/<version>` — `fetch` with `redirect: "error"` and a 15 s
     `AbortSignal.timeout`, 200 → `published=true`, 404 → `published=false`, anything else or no answer fails; download
     `npm-tarball`; "Publish" only `if: steps.registry.outputs.published == 'false'`, validating the tarball name as
     today and running `npm publish "./pkg/${TARBALL}" --provenance --access public --ignore-scripts`.
   - `release` (`needs: [gate, publish]`, the exact `if:` above, `permissions: contents: write` only; checks out and
     installs nothing): download `npm-tarball`; "Tag and release" with `GH_TOKEN: ${{ github.token }}` and
     `TAG: v<version>` — exit 0 if `gh release view "$TAG" --repo "$GITHUB_REPOSITORY"` succeeds, else
     `gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" --title "$TAG"
--notes-file pkg/RELEASE_NOTES.md`.

**Where the checks run (the SPEC's `npm test` collection).** The SPEC's Assumption says checks placed _outside_
`src/` would need vitest's `include` widened. Widening `vitest.config.mts` is a test-infrastructure change — a
`test-infra-in-plan` RED, which must be its own `spec_kind: test-infra` increment. This plan therefore does **not**
touch the runner config: the two checks are Node-core-only scripts under `scripts/`, and the AC tests that run them
live under the existing include (`src/release/*.test.ts`, mapped in `AC-TESTS.md`), so `npm test` collects them on
every PR — the same convention earlier features used for tests of non-`src/` code (`src/dashboard/example-express-app.*`,
`src/analyzer/example-worker-pool.*`). Both tsconfig build projects exclude `src/**/*.test.ts`, so nothing new is
built or packed.

**Docs.** `docs/RELEASING.md` is rewritten for release-on-merge; `CHANGELOG.md` gets an `[Unreleased]` entry and a new
header sentence; `CONTRIBUTING.md` and `CLAUDE.md` lose the "releases are cut by hand / by GitHub Release" lines;
`scripts/pack-release.mjs`'s step-summary sentence ("Publishing requires a GitHub Release …") becomes true for the new
flow. No version bump, tag or Release is made (package stays 0.1.0).

## Applied lessons

- none — `node pharn/floor/check-lessons-index.mjs . --verdict` returned `NO_CANON`: this project has no
  `memory-bank/lessons-learned.md` yet, so there are no promoted lessons to apply.

## Steps

- Write `scripts/changelog-section.mjs` (pure `changelogSection(text, version)`, JSDoc types, Node core only,
  header comment stating the literal-compare rule).
- Write `scripts/release-notes.mjs` as the CLI over it (exactly one stderr line and exit 1 on every failure; stdout
  only on success).
- Write `scripts/check-release-consistency.mjs` (`--root`, collect-all failures, exit codes 0/1/2 as above).
- Write `scripts/workflow-yaml.mjs` (fail-closed subset parser, positioned errors, duplicate-key refusal).
- Write `scripts/check-publish-workflow.mjs` (structural assertions + the stub-`git` gate-decision scenarios, every
  `spawnSync` with a timeout, temp dirs cleaned in `finally`).
- Rewrite `.github/workflows/publish.yml` to the four-job flow above, reusing the existing pinned SHAs
  (`actions/checkout@3d3c42e5…`, `actions/setup-node@82076278…`, `actions/upload-artifact@043fb46d…`,
  `actions/download-artifact@3e5f45b2…`) with their version comments.
- Update the step-summary sentence in `scripts/pack-release.mjs` (text only; packing behaviour unchanged).
- Rewrite `docs/RELEASING.md`: how to cut a release (one PR bumping `package.json` + `package-lock.json` via
  `npm version --no-git-tag-version`, moving `Unreleased` notes into `## [X.Y.Z] - YYYY-MM-DD`, fresh `Unreleased`);
  what `gate` / `build` / `publish` / `release` each do and hold; the kill-switch (`NPM_PUBLISH_ENABLED` exactly
  `true`, else `publish` and `release` skip while `gate` and `build` run); re-run and recovery (re-run failed jobs;
  the registry check skips a re-publish; an existing Release is left alone; `workflow_dispatch` on `main` re-drives a
  release whose run was cancelled; a run on any other ref fails at `gate`); the local reproduction commands; the
  first-publish bootstrap kept as the 0.1.0 history, worded accurately for the new triggers; the Trusted Publishing
  section unchanged in substance (workflow filename `publish.yml` and environment `npm-publish` are unchanged, so no
  npm reconfiguration is needed); verify-a-release section kept.
- Update `CHANGELOG.md`: the header sentence (a PR that bumps the version is the release; merging it to `main`
  publishes — see `docs/RELEASING.md`) and a `### Changed` entry under `## [Unreleased]`.
- Update `CONTRIBUTING.md` "Commits & releases" and `CLAUDE.md` "Open-source-from-day-one" lines.
- Run `npx prettier --write` on each written file, one by one (including the YAML and Markdown), then
  `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run check:pins`.

## Files

- `scripts/changelog-section.mjs` — new: pure `changelogSection(text, version)` (literal heading compare, body rules)
- `scripts/release-notes.mjs` — new: CLI `node scripts/release-notes.mjs <X.Y.Z> [CHANGELOG.md]` over it (AC-1)
- `scripts/check-release-consistency.mjs` — new: the release-consistency check run by `npm test` (AC-2)
- `scripts/workflow-yaml.mjs` — new: fail-closed YAML-subset parser for workflow files
- `scripts/check-publish-workflow.mjs` — new: the publish-workflow check, structural + stub-`git` gate execution (AC-3)
- `.github/workflows/publish.yml` — rewritten: push-on-`main` + `workflow_dispatch`, `gate` → `build` → `publish` → `release`
- `scripts/pack-release.mjs` — step-summary sentence only, to describe the release-on-merge flow
- `docs/RELEASING.md` — rewritten for release-on-merge (cut, jobs, kill-switch, re-run and recovery, bootstrap, Trusted Publishing)
- `CHANGELOG.md` — header sentence and an `[Unreleased]` `### Changed` entry for this change
- `CONTRIBUTING.md` — "Commits & releases": releases publish when a version-bump PR merges to `main`
- `CLAUDE.md` — convention: releases publish on merge — a PR bumping `package.json`, `package-lock.json` and a `## [X.Y.Z]` CHANGELOG section is the release

### Explicitly not touched

- `vitest.config.mts` — runner config (test infrastructure); the AC tests sit inside the existing `src/**/*.test.ts` include instead
- `package.json` — no version bump, no new script, no dependency
- `package-lock.json` — the version stays 0.1.0
- `ROADMAP.md` — its release lines describe the 0.1.0 history accurately
- `src/` runtime code — out of scope; only the AC test files (listed in `AC-TESTS.md`) live under `src/release/`
- `.github/workflows/ci.yml` — `npm test` already runs the new checks on every PR

## Acceptance mapping

- AC-1 → `scripts/release-notes.mjs` over `scripts/changelog-section.mjs`: plain X.Y.Z + exactly one
  `## [X.Y.Z]` heading + non-empty body → exit 0 and the body (under the heading, up to the next `## ` heading or the
  link-reference block); malformed version / absent heading / repeated heading / empty body → exit 1, empty stdout,
  exactly one stderr line. Driven by `src/release/release-notes.ac1.integration.test.ts`.
- AC-2 → `scripts/check-release-consistency.mjs`: green at HEAD (0.1.0 in both package files, non-empty
  `## [0.1.0]` section), exit 1 for a `--root` copy whose version is bumped past 0.1.0 in both package files with no
  CHANGELOG section. Run by `npm test` through `src/release/release-consistency.ac2.integration.test.ts`.
- AC-3 → `scripts/check-publish-workflow.mjs` (with `scripts/workflow-yaml.mjs`) over the rewritten
  `.github/workflows/publish.yml`: every structural assertion in AC-3 plus the stub-`git` gate scenarios
  (`ls-remote` 0 → `release=false`, 2 → `release=true`, other → failure, wrong ref or non-X.Y.Z version → failure
  before git). Run by `npm test` through `src/release/publish-workflow.ac3.integration.test.ts`.

## Risks & open questions

- **Test location (flag for the human).** The AC tests live in a new `src/release/` directory that holds tests only
  (no module, nothing built or packed) — chosen so `npm test` collects them without a runner-config change. If the
  maintainer prefers a top-level `tests/` directory, that needs a separate `spec_kind: test-infra` increment widening
  `vitest.config.mts`'s `include`, after which these tests can move.
- **`bash` required by the AC-3 check.** The gate step is a bash script, so the check runs it with `bash`; CI is
  `ubuntu-latest` and macOS ships bash 3.2 (the step uses only `[[ =~ ]]`, `case`, `set -euo pipefail`, all 3.2-safe).
  On a machine with no `bash` the check fails closed with a named reason. Windows development is not covered.
- **Parser scope.** `scripts/workflow-yaml.mjs` reads a subset of YAML. A future edit to `publish.yml` that uses an
  unsupported construct makes the check fail (closed) rather than misread; the error names the line.
- **`workflow_dispatch` semantics change.** Today a manual run only prepares an artifact; after this change a manual
  run on `main` re-drives a release (and publishes if `NPM_PUBLISH_ENABLED` is `true` and the version is untagged).
  `docs/RELEASING.md` must say so plainly.
- **Not executed by any test (SPEC Assumption).** The publish job's registry idempotency step and the `release` job's
  `gh` calls are built and statically pinned but not executed; their first real execution is the next release.
- **Existing tag.** `v0.1.0` exists, so the first push to `main` after merge ends at `gate` with `release=false`.
- **Formatting.** Prettier formats YAML and Markdown here; every written file must pass `npm run format:check`.
