<!--
Thanks for contributing to Argus! Please read CONTRIBUTING.md and CLAUDE.md first.
Keep one logical change per PR. The PR title must be a Conventional Commit
(feat: / fix: / docs: / chore: ...) — PRs are squash-merged and the title becomes the commit
message on main. User-visible changes also get a line under "Unreleased" in CHANGELOG.md.
-->

## What this changes

A short description of the change and the problem it solves.

Closes #<!-- issue number -->

## Type of change

- [ ] `feat` — new capability
- [ ] `fix` — bug fix
- [ ] `docs` — docs-only change
- [ ] `chore` / `refactor` / `test` / `ci` — no behavior change

## Module(s) touched

<!-- src/agent | src/collector | src/analyzer | src/dashboard | src/plugin-runner | examples | docs | repo tooling -->

## Checklist

- [ ] Tests added or updated (bug fixes include a regression test).
- [ ] No third-party dependency or cross-module import added to `src/agent`; no runtime
      `dependencies` added to the root `package.json`.
- [ ] TypeScript strict; no `any` without a comment explaining why.
- [ ] Streams use `stream/promises` `pipeline()`, never `.pipe()`; no stream, worker or plugin
      execution without explicit error handling.
- [ ] `async_hooks` is imported only in `src/agent/context.ts`; worker files live in
      `*/src/workers/`.
- [ ] Counter aggregation uses integer math.
- [ ] Docs updated (`README.md`, `ARCHITECTURE.md`, `FEATURES.md`) if behavior or scope changed.

## Overhead (required for changes in the agent's hot path)

<!-- Benchmark note: agent-on vs agent-off, workload, and result. Write "n/a" if not in the hot path. -->

## Security-sensitive changes

<!-- Touches the dashboard/SSE endpoint, auth/token handling, redaction, heap snapshots, disk
persistence, the plugin sandbox, or the analyzer's parsing? Say what changed and what you checked.
Write "n/a" otherwise. -->

## Notes for the reviewer

Anything the reviewer should look at first.
