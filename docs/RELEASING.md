# Releasing Phargus

A maintainer decides when to release and what the version is. Version 0.1.0 is the first public
release; its npm publication follows the manual bootstrap below. Preparing an artifact does not publish it.

## Prepare the repository and artifact

1. Prepare a PR with the package version and matching lockfile version, changelog notes and
   documentation. The package must not be `private`. Before 1.0, a breaking change bumps the minor
   version. The first release notes remain under `Unreleased` until the release is cut.
2. Require green CI: format, lint, typecheck, tests, action pins, dual build, export checks,
   package contents and installed-package checks. CI checks the consumer on Node 22.18.0 and 24.
3. Merge to `main`. Run **publish → Run workflow** on `main` to prepare an artifact before tagging.
   The selected commit must be in the history of `main`. Manual runs **never publish**, even when
   publishing is enabled for releases.
4. Download `npm-tarball` within 14 days. It contains the `.tgz` and `metadata.json` with its
   version, commit and SHA-256; the workflow summary records the same values. Keep both files
   together. Check the checksum after downloading (`shasum -a 256 <tarball.tgz>`).

To reproduce preparation locally from a clean checkout with the Node version in `.nvmrc`:

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
node scripts/pack-release.mjs /tmp/phargus-package
npm run check:install -- /tmp/phargus-package/pharn-dev-phargus-0.1.0.tgz
```

`pack-release.mjs` packs the already built output without running scripts again. Always build and
run the gates first. `check:install` takes a prebuilt tarball, installs it outside the repository,
and checks ESM/CJS imports, strict NodeNext declarations, both analyzer workers, the plugin child
with and without `isolated-vm`, and agent samples through the collector to the dashboard and SSE.
It installs lockfile-pinned tooling and the native peer, so it needs registry access and native
addon build prerequisites. Temporary consumers and subprocesses are cleaned up on failure too.

## First publish: manual bootstrap

Account setup and the actual publish are a separate step after repository preparation.

1. Confirm that your npm account can publish `@pharn-dev/phargus` and has 2FA enabled. The package
   does not exist on the registry yet, so configure Trusted Publishing after its first publish.
2. Leave the **repository** Actions variable `NPM_PUBLISH_ENABLED` unset (or `false`). This makes
   a GitHub Release build and check its artifact without starting the publishing job.
3. Cut the release on `main`: turn `Unreleased` into `[0.1.0] - YYYY-MM-DD` using the actual release
   date, add a fresh `Unreleased` section, and update README, roadmap and security status to reflect
   the release being cut. Merge with green CI, then tag that commit `v0.1.0` and publish a GitHub
   Release with the changelog notes. Download its checked artifact and verify its checksum.
4. Log in and publish **that exact tarball**, without rebuilding or executing its scripts:

   ```bash
   npm login
   npm publish ./pharn-dev-phargus-0.1.0.tgz --access public --ignore-scripts --provenance=false
   ```

   This one-time manual publish has no CI provenance. The Release workflow's publish job is
   skipped; there is no automatic duplicate publish to cancel. If publication fails, leave the
   status as pending; update documentation to confirm availability only after verification.

5. Verify the registry version and installation as described below. Update any remaining pending
   publication status in a documentation PR.

## Enable Trusted Publishing for subsequent releases

On npmjs.com configure the package's Trusted Publisher with:

- Provider: GitHub Actions.
- Organization/user: `pharn-dev`.
- Repository: `phargus`.
- Workflow filename: `publish.yml` (only the filename).
- Environment: `npm-publish`.
- Allowed action: direct `npm publish` (this workflow does not use staged publishing).

The GitHub `npm-publish` environment requires maintainer review. Set the **repository** Actions
variable `NPM_PUBLISH_ENABLED` to exactly `true` only after npm setup, when the next release is
ready. A new Trusted Publisher must complete its first successful publish within two days; create
it close to that next release. Do not enable publishing and rerun the first release after its
version has already been published. Repository, workflow and environment names must match npm's
configuration; renaming them requires a new matching configuration.

See [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Subsequent releases

1. Open `release/vX.Y.Z` changing the version in both package files and finalizing the changelog
   section with the release date, plus a fresh `Unreleased` section. Merge after green CI.
2. Publish GitHub Release `vX.Y.Z` on the corresponding commit on `main`. Tags must be strict
   `vX.Y.Z`, match the package version, and point at a commit in `main`.
3. The build job checks and packs the artifact without OIDC rights. Only the publish job has
   `id-token: write`; it checks out nothing, installs nothing, and publishes the same tarball with
   `--ignore-scripts --provenance`. No npm publishing token is stored in GitHub.
4. Approve the `npm-publish` environment, then verify the release. Manual workflow runs still
   prepare artifacts only. Missing or non-`true` `NPM_PUBLISH_ENABLED` always skips publishing.

## Verify a published release

- `npm view @pharn-dev/phargus version` reports the expected version.
- Install it from the registry in an empty project and load all six subpaths with both `import`
  and `require`. The workflow already checks the packed artifact, but this confirms registry delivery.
- For subsequent CI releases, confirm the publish job is green and npm displays provenance.
  The manual first release is the documented exception.

If a release is bad, publish a fixed patch version and, if needed, `npm deprecate` the broken one.
Do not delete a published version or retry publication of the same version.
