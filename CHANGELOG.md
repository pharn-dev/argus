# Changelog

All notable changes to Argus are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Releases are cut by hand; see
[`docs/RELEASING.md`](./docs/RELEASING.md).

## [Unreleased]

### Added

- Single npm package with five modules exposed as subpath exports (`argus/agent`,
  `argus/collector`, `argus/analyzer`, `argus/dashboard`, `argus/plugin-runner`), built as both ESM
  and CommonJS.
- Open-source baseline: `README.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `docs/THREAT-MODEL.md`,
  `docs/LIMITS.md`, issue and pull request templates.
- CI: format, lint, typecheck, test, build, action-pin checks, CodeQL and gitleaks.
- Manual release process with npm Trusted Publishing and provenance.
