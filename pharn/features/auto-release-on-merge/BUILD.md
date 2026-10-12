# BUILD — auto-release-on-merge

- plan built: `pharn/features/auto-release-on-merge/PLAN.md` (carries `spec_content_hash` `1ee5d88ae90de129442872ff2317020b40a5fe3015c11007b6ab95ecb2522715`)
- chain gate: GREEN (`pharn/floor/check-plan-spec-agree.mjs`)
- test-stage gate: `READY test-first` (`pharn/floor/check-test-stage.mjs`)
- writes-scope set from the plan's `## Files` (11 paths):
  `scripts/changelog-section.mjs`, `scripts/release-notes.mjs`, `scripts/check-release-consistency.mjs`,
  `scripts/workflow-yaml.mjs`, `scripts/check-publish-workflow.mjs`, `.github/workflows/publish.yml`,
  `scripts/pack-release.mjs`, `docs/RELEASING.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CLAUDE.md`
- gate result: passed. `build-gate.mjs --mode targeted` exit 0 (3 AC test files) and `--mode full` exit 0
  (test, lint, format:check, typecheck, build). `npm run check:pins` also printed ok.
- files written: the 11 paths above (`scripts/pack-release.mjs`: the step-summary sentence only)
- skills: mode=none (no-skills)
- seams: none touched (Node core and a GitHub Actions workflow; Step 2c not entered)

Not run by this stage: `check:exports`, `check:package` and `check:install` (the new workflow runs
them in its `build` job; they are not part of `/pharn-verify`'s discovered gates here), and the
publish job's registry check and the release job's `gh` calls, which no test executes.

Between the test stage and this build, a commit `3c5cdf9` ("update pharn", author
pgalarowicz@gmail.com, 2026-10-12 17:18) landed on `main` directly and already holds the
three new scripts `changelog-section.mjs`, `release-notes.mjs`, `check-release-consistency.mjs`,
the three AC test files and the feature's earlier artifacts. It was not made by this stage.

Built within the named scope from a current approved plan — this is NOT a judgment that the code is
correct; that is `/pharn-regress` / `/pharn-verify` + the human.
