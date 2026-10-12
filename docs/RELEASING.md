# Releasing Phargus

Releases publish on merge: a pull request that bumps the version **is** the release. When it merges to
`main`, [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) builds and checks the
package, publishes it to npm, then tags the commit and creates the GitHub Release. A merge that does not
bump the version releases nothing. Authentication is **npm Trusted Publishing (OIDC)**: no npm token
is stored in this repository or in GitHub. A maintainer still decides when to release and what the
version is, because they decide when to merge the bump.

## Cut a release

Put the release in the pull request that ships the change, or in a PR of its own when several merged
changes go out together:

1. **Bump the version** in `package.json` and `package-lock.json` (plain `X.Y.Z`; prereleases are
   refused). Before 1.0, a breaking change bumps the minor version. The package must not be `private`.

   ```bash
   npm version --no-git-tag-version 0.2.0
   ```

2. **Update `CHANGELOG.md`.** Move the `Unreleased` entries under a new `## [X.Y.Z] - YYYY-MM-DD`
   heading (the release date) and leave a fresh, empty `## [Unreleased]` section above it. The section
   under that heading becomes the GitHub Release notes, verbatim. Update README, roadmap and security
   status when the release changes them.
3. **Merge the PR** once CI is green. `npm test` includes `src/release/`, which runs
   `scripts/check-release-consistency.mjs`: it fails the PR when `package-lock.json` does not carry the
   same version or `CHANGELOG.md` has no non-empty section for it, so a half-done bump is caught before
   the merge. Whether a PR should bump, and to which level, is the author's and reviewer's call; no check
   can know that.
4. **Approve the `npm-publish` environment** when the run reaches the `publish` job (the environment
   requires maintainer review), then [verify the release](#verify-a-published-release).

A PR that does **not** bump the version releases nothing: leave the version alone and add your entry
under `Unreleased`. Docs and dependency merges work the same way.

To reproduce the build job locally from a clean checkout with the Node version in `.nvmrc`:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run check:pins
npm run build
npm run check:exports
npm run check:package
node scripts/release-notes.mjs 0.2.0 CHANGELOG.md > /tmp/RELEASE_NOTES.md
node scripts/pack-release.mjs /tmp/phargus-package
npm run check:install -- /tmp/phargus-package/pharn-dev-phargus-0.2.0.tgz
```

`pack-release.mjs` packs the already built output without running scripts again. Always build and run
the gates first. `check:install` takes a prebuilt tarball, installs it outside the repository, and
checks ESM/CJS imports, strict NodeNext declarations, both analyzer workers, the plugin child with and
without `isolated-vm`, and agent samples through the collector to the dashboard and SSE. It installs
lockfile-pinned tooling and the native peer, so it needs registry access and native addon build
prerequisites. Temporary consumers and subprocesses are cleaned up on failure too.

## What the merge runs

Every push to `main` runs `publish.yml`. Its four jobs run one after another, and a workflow-level
`concurrency` group keeps two runs from overlapping (a run in progress is never cancelled):

- **`gate`** refuses any ref other than `main`, requires `package.json`'s `version` to be plain
  `X.Y.Z`, and asks the remote whether the tag `vX.Y.Z` exists (`git ls-remote --exit-code`). Tag
  present: the run ends here, green, having published nothing. Tag absent: release. Any other answer
  (network, auth) fails the run rather than guessing. It installs nothing and holds no write permission.
- **`build`** holds no publish rights (no `id-token`). Before installing anything it checks the version
  again and that the commit is contained in `main`, and extracts the release notes with
  `scripts/release-notes.mjs` (a missing or empty CHANGELOG section fails here). It then runs `npm ci`,
  the gates, the build and package checks, packs the tarball, checks the packed version, runs the
  installed-package smoke test, and uploads `npm-tarball` (the tarball, `metadata.json` with its version,
  commit and SHA-256, and `RELEASE_NOTES.md`) for 14 days. The workflow summary records the same values.
- **`publish`** is the only job with `id-token: write` and the `npm-publish` environment. It checks out
  nothing and installs nothing: it asserts the bundled npm meets Trusted Publishing's floor, asks the
  registry whether the version is already published (HTTP 200 skips the publish, 404 publishes, anything
  else fails the run), then runs `npm publish <tarball> --provenance --access public --ignore-scripts`.
- **`release`** is the only job with `contents: write`. It checks out nothing and installs nothing: it
  runs `gh release create vX.Y.Z` at the built commit with the extracted notes, which also creates the
  tag. A Release that already exists is left alone.

npm comes first and the tag second, so a tag always means the version is on npm. A Release created with
the workflow's `GITHUB_TOKEN` starts no other workflow, which is why tagging happens inside this run.

Why the split: every step of a job that holds `id-token: write` can request the token npm trades for
publish rights. Keeping the dev toolchain (install scripts, linters, tests, bundler) out of that job
means a compromised dev dependency can no longer publish on its own. It can still influence the
tarball's content in `build`, the residual this does not close.

`npm test` pins the workflow's triggers, job graph and per-job permissions and executes its gate
decision step against a stub `git` (`scripts/check-publish-workflow.mjs`). It never executes the
registry check or the `gh` calls, so the first real run of those is the next release.

### The publish switch

The **repository** Actions variable `NPM_PUBLISH_ENABLED` must be exactly `true` for `publish` and
`release` to run. Missing, empty or anything else skips both (a tag must still mean "on npm"), while
`gate` and `build` still run, so a merged bump still produces a checked artifact you can download from
the run.

## When a release run fails

- **Re-run it.** Every job is safe to repeat: the gate releases only while the tag is absent, `publish`
  skips a version npm already has, and `release` leaves an existing Release alone. A run that failed
  after npm but before the tag picks up where it stopped.
- **A failed run that nobody re-runs is picked up by the next merge.** Its `gate` still finds no tag for
  the version on `main`, so it releases that version, built from the later commit, which includes
  whatever merged in between. Re-run the failed run first if the release should contain exactly the
  bump commit.
- **A run that was cancelled or never ran** can be started again from **Actions → publish → Run
  workflow** on `main`. Unlike before this flow, a manual run on `main` **can publish**: it releases the
  version currently on `main` if that version has no tag, and `NPM_PUBLISH_ENABLED` is `true`. A manual
  run on any other ref fails at `gate`.
- **A tag that exists without a release behind it** (pushed by hand, say) makes the gate skip that
  version for good. Delete it (`git push --delete origin vX.Y.Z`) and re-run, or bump to the next version.
- **Queued runs can be superseded.** GitHub keeps one pending run per concurrency group. If several
  version bumps merge while a release is running, only the newest waiting run survives, and an
  intermediate version may never be published. Its CHANGELOG section then describes a version npm never
  had.
- If a release is bad, publish a fixed patch version and, if needed, `npm deprecate` the broken one. Do
  not delete a published version or retry publication of the same version.

## First publish: manual bootstrap

npm only lets you configure a Trusted Publisher on a package that **already exists**, so the first
publish of this package name is manual. Version 0.1.0 was the first release and was tagged by hand
before release-on-merge existed; the steps below stay the procedure for any package name that does not
exist on the registry yet.

1. Confirm that your npm account can publish `@pharn-dev/phargus` and has 2FA enabled.
2. Leave the **repository** Actions variable `NPM_PUBLISH_ENABLED` unset (or `false`). Merging the
   version bump then runs `gate` and `build` and uploads the checked `npm-tarball` artifact, without
   starting `publish` or `release`.
3. Download `npm-tarball` and verify its checksum (`shasum -a 256 <tarball.tgz>` against
   `metadata.json`).
4. Log in and publish **that exact tarball**, without rebuilding or executing its scripts:

   ```bash
   npm login
   npm publish ./pharn-dev-phargus-0.1.0.tgz --access public --ignore-scripts --provenance=false
   ```

   This one-time manual publish has no CI provenance. If publication fails, leave the status as
   pending; update documentation to confirm availability only after verification.

5. Tag the merged commit `vX.Y.Z` and publish a GitHub Release with the changelog notes by hand
   (`release` was skipped), then verify the registry version and installation as described below.
   Update any remaining pending publication status in a documentation PR.

## Enable Trusted Publishing for subsequent releases

On npmjs.com configure the package's Trusted Publisher with:

- Provider: GitHub Actions.
- Organization/user: `pharn-dev`.
- Repository: `phargus`.
- Workflow filename: `publish.yml` (only the filename).
- Environment: `npm-publish`.
- Allowed action: direct `npm publish` (this workflow does not use staged publishing).

The GitHub `npm-publish` environment requires maintainer review. Set the **repository** Actions
variable `NPM_PUBLISH_ENABLED` to exactly `true` only after npm setup, when the next release is ready.
A new Trusted Publisher must complete its first successful publish within two days; create it close to
that next release. Repository, workflow and environment names must match npm's configuration; renaming
them requires a new matching configuration. The workflow file and environment keep their names under
release-on-merge, so nothing changes on the npm side. Nothing in this repository can check the npmjs.com
side, so the first release after this change is also the test that it accepts a `push`-triggered run.

See [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Verify a published release

- The `publish` workflow run for the merge is green, and the **Releases** page shows `vX.Y.Z` with the
  CHANGELOG section as its notes.
- `npm view @pharn-dev/phargus version` reports the expected version.
- Install it from the registry in an empty project and load all six subpaths with both `import` and
  `require`. The workflow already checks the packed artifact, but this confirms registry delivery.
- For releases made by CI, npm displays provenance for the version. The manual first release is the
  documented exception.
