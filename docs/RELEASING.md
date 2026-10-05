# Releasing Argus

Releases are cut by a maintainer, by hand. There is no release bot: a person decides when to
release and what the version is. CI does the part that must not depend on a person's laptop —
building, checking and publishing the tarball with a provenance attestation.

## How publishing is authenticated

Publishing uses **npm Trusted Publishing (OIDC)**. No npm token or secret is stored in GitHub.

- On npmjs.com the package lists this repository's workflow `publish.yml` and the GitHub
  environment `npm-publish` as its Trusted Publisher.
- `.github/workflows/publish.yml` runs when a **GitHub Release is published**. It has two jobs, and
  the split is deliberate: `build` installs dependencies and runs every gate but holds no publish
  rights; `publish` holds the OIDC token but installs nothing and only publishes the tarball that
  `build` produced, with `--ignore-scripts --provenance`.
- `build` refuses to continue unless the tag is a strict `vX.Y.Z`, equals `package.json`'s
  `version`, points at a commit on `main`, and `package.json` is not `private`.

Create the `npm-publish` environment in the repository settings (Settings → Environments) and
consider requiring a reviewer on it, so a release needs a second click before it reaches npm.

## Cutting a release

1. **Pick the version** ([SemVer](https://semver.org/)). Before 1.0, a breaking change bumps the
   minor version.
2. **Open a release PR** from a branch named `release/vX.Y.Z` that changes only:
   - `package.json` (and `package-lock.json`): `"version": "X.Y.Z"`;
   - `CHANGELOG.md`: rename `Unreleased` to `[X.Y.Z] - YYYY-MM-DD`, add a fresh empty `Unreleased`
     section above it, and update the comparison links if you keep them.
3. **Merge it** once CI is green. The tag must point at a commit on `main`.
4. **Create the GitHub Release**: tag `vX.Y.Z` targeting `main`, release notes copied from the
   changelog section. Publishing the release starts `publish.yml`.
5. **Approve the `publish` job** if the `npm-publish` environment requires a reviewer.

## Verify the release

- The `publish` workflow run is green.
- `npm view <name> version` shows `X.Y.Z`, and the package page shows the provenance badge.
- In an empty directory: install the package and load each subpath with both `import` and
  `require` (the `build` job runs the same check against the packed tarball before publishing).

If a release is bad, do not delete it from npm. Publish a fixed patch version and, if needed,
`npm deprecate` the broken one.

## First publish of a new package name (one-time exception)

Trusted Publishing can only be configured for a package that already exists on the registry, so
the very first publish is manual:

1. Make sure the name is free and yours: `npm view <name>`. **The unscoped name `argus` is already
   taken on npm by an unrelated package**, so the first release needs a different name (for example
   a scoped one such as `@pharn-dev/argus`). Change `name` in `package.json` and the install
   snippets in `README.md` together, and keep the import specifiers in docs in sync.
2. Remove `"private": true` from `package.json` in the release PR (the publish workflow refuses a
   private package on purpose).
3. From a clean checkout of the tagged commit on `main`, run `npm ci && npm publish --access public`
   with your own npm login (2FA on).
4. On npmjs.com, add the Trusted Publisher (repository, `publish.yml`, environment `npm-publish`)
   under the package's settings. Every later release goes through CI.
