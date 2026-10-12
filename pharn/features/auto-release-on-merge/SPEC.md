---
spec_id: auto-release-on-merge
state: Approved
spec_content_hash: 1ee5d88ae90de129442872ff2317020b40a5fe3015c11007b6ab95ecb2522715
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Phargus releases today only when a maintainer publishes a GitHub Release by hand, which triggers
`.github/workflows/publish.yml`. The maintainer wants the same release-on-merge flow that pharn-cli
uses: a pull request that bumps `package.json`'s version (with `package-lock.json` and a matching
`## [X.Y.Z] - date` CHANGELOG section) IS the release, and merging it to `main` publishes to npm and
then tags and creates the GitHub Release automatically. A merge that does not bump the version
publishes nothing. Doing this now removes the manual step right after the first release (0.1.0) and
keeps every later release reproducible from `main`, with the same least-privilege job split
pharn-cli uses so no job that installs dev dependencies can mint an npm publish token.

## Scope

**In scope:**

- A Node-core-only `scripts/release-notes.mjs <X.Y.Z> [CHANGELOG.md]` that prints one version's
  CHANGELOG section, comparing the version as a literal (never inside a RegExp).
- Converting `.github/workflows/publish.yml` to push-on-`main` plus `workflow_dispatch` (recovery),
  with four jobs `gate` → `build` → `publish` → `release`: `gate` decides from the remote tag whether
  to release and installs nothing; `build` (no `id-token`) re-verifies the version and that the commit
  is on `origin/main`, extracts the release notes before `npm ci`, runs Phargus's existing gates
  (format:check, lint, typecheck, test, check:pins, build, check:exports, check:package), packs with
  `scripts/pack-release.mjs`, runs the `check:install` smoke, and uploads the tarball plus
  `RELEASE_NOTES.md`; `publish` is the only job with `id-token: write` and the `npm-publish`
  environment, checks out and installs nothing, asserts the npm floor, skips the publish when the
  registry already has the version, and otherwise publishes the prebuilt tarball with
  `--provenance --access public --ignore-scripts`; `release` is the only job with `contents: write`,
  checks out and installs nothing, and creates tag `vX.Y.Z` and the GitHub Release from the notes at
  the built commit, leaving an existing Release alone.
- Workflow-level `concurrency` that never cancels a run in progress, and default
  `permissions: contents: read`.
- Keeping `vars.NPM_PUBLISH_ENABLED == 'true'` as the kill-switch: when it is not exactly `true`,
  `publish` AND `release` are skipped, while `gate` and `build` still run.
- A release-consistency check and a publish-workflow check, both run by `npm test` on every PR.
- Docs: `docs/RELEASING.md` rewritten for release-on-merge (how to cut a release, what the four jobs
  do, re-run and recovery; the bootstrap and Trusted Publishing sections stay accurate); a CHANGELOG
  `[Unreleased]` entry for this change and its header sentence; and every other doc line that says
  releases are cut by hand or by publishing a GitHub Release (CLAUDE.md "Open-source-from-day-one",
  CONTRIBUTING.md).

**Out of scope (non-goals):**

- Bumping the package version, or creating any tag or GitHub Release.
- Changing npm, npmjs.org Trusted Publisher, GitHub environment, variable or repository settings.
- Any `src/` runtime code.
- Weakening Phargus's existing build gates, pack step or SHA-pinned actions.

## Acceptance Criteria

- **AC-1** Given a CHANGELOG file and a version When `node scripts/release-notes.mjs <version> <file>`
  runs Then for a plain X.Y.Z version with exactly one `## [X.Y.Z]` heading and a non-empty body it
  exits 0 and prints that body (the text under the heading up to the next `## ` heading or the
  link-reference block), and for a malformed version, an absent heading, a repeated heading, or an
  empty body it exits 1, prints nothing on stdout and writes exactly one line to stderr
  - verify: integration
- **AC-2** Given the repository at HEAD When `npm test` runs Then a release-consistency check passes
  that asserts `package.json` version is plain X.Y.Z, `package-lock.json` root `version` and
  `packages[""].version` equal it, and `CHANGELOG.md` has a non-empty `## [X.Y.Z]` section for it,
  and the same check reports a failure for a version bumped past the current one that has no
  CHANGELOG section
  - verify: integration
- **AC-3** Given the committed `.github/workflows/publish.yml` When `npm test` runs Then a
  publish-workflow check passes that asserts the triggers are exactly push to `main` and
  `workflow_dispatch`; workflow-level concurrency with `cancel-in-progress: false`; default
  `permissions: contents: read`; jobs chained `gate` → `build` → `publish` → `release`; only
  `publish` holds `id-token: write` and the `npm-publish` environment; only `release` holds
  `contents: write`; `publish` and `release` each run only when the gate's release output is `true`
  and `vars.NPM_PUBLISH_ENABLED == 'true'`; and, executing the committed gate decision step against a
  stub `git` with no network, it outputs `release=false` when `git ls-remote` exits 0, `release=true`
  when it exits 2, fails on any other exit, and fails before calling git for a ref other than
  `refs/heads/main` or a version that is not plain X.Y.Z
  - verify: integration

## Constraints

- The flow mirrors pharn-cli's `publish.yml` job split and per-job permissions (`gate` and `build`
  hold no write permission and no `id-token`; only `publish` holds `id-token: write`; only `release`
  holds `contents: write`; `release` runs after npm so a tag always means "on npm").
- Every action in the workflow stays pinned to a 40-character commit SHA (`npm run check:pins`).
- The release-notes script and both checks use Node core only and add no dependency; the root
  `package.json` keeps no runtime `dependencies`.
- The checks run with no network access and never invoke the real npm or publish anything.
- Every new or edited file passes `npm run typecheck`, `npm run lint` and `npm run format:check`, and
  the new checks are collected by `npm test`.
- The package version stays 0.1.0 in this change.

## Assumptions

- `npm test` runs vitest, whose `include` today covers only `src/**/*.test.ts`; checks placed
  outside `src/` need that `include` widened so `npm test` collects them.
- The docs updates in Scope are checked by review, not by an automated test.
- The publish job's registry idempotency check (HTTP 200 skips the publish, 404 publishes, anything
  else fails) is built and pinned in the workflow, but only the gate decision step is executed by a
  test; the registry step is not executed against a stub server in this increment.
- `workflow_dispatch` stays available as the recovery trigger, and the gate still refuses any ref
  other than `refs/heads/main` for it.
- The existing 14-day retention of the uploaded tarball artifact is kept.
- The existing `v0.1.0` tag and package version 0.1.0 mean the first push to `main` after this change
  ends at `gate` with nothing to release.
