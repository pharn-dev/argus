# Contributing to Argus

Thanks for your interest in Argus — _all-seeing runtime diagnostics for Node.js._

## Project shape

Monorepo on **pnpm workspaces**. Packages live under `packages/` (`@argus/agent`,
`@argus/collector`, `@argus/analyzer`, `@argus/dashboard`, `@argus/plugin-runner`).
See `ARCHITECTURE.md` for how they fit together and `CLAUDE.md` for the hard rules.

## Getting set up

```bash
npm install
npm run typecheck  # TypeScript on repo sources (excludes packages/)
npm test
npm run lint
npm run format:check

# After S0 (pnpm workspace scaffold):
pnpm install
pnpm -w build      # tsc --build across the workspace
pnpm -w test
pnpm -w lint
pnpm -w format:check
```

Before committing (root still uses npm until the workspace lands):

```bash
npm run typecheck
npm test
npm run lint
npm run format        # or format:check in CI
```

## The rules that PRs are checked against

- **`@argus/agent` has zero external dependencies.** A PR adding a third-party
  dependency to the agent will not be merged. Use Node core.
- TypeScript strict mode. No `any` without a comment explaining why.
- Streams use `stream/promises` `pipeline()`, never `.pipe()`.
- Worker Thread files live in `*/src/workers/`; no inline `eval`-based workers.
- `async_hooks` is imported only in `@argus/agent/src/context.ts`.
- Every stream / worker / plugin execution has explicit error handling. No silent
  failures.
- Counter aggregation uses integer math.
- The agent must not measurably slow the monitored process — include a benchmark
  note for anything in the hot path.

## Commits & releases

- **Conventional Commits** (`feat:`, `fix:`, `chore:`, …). Releases are automated
  via `semantic-release`, so commit messages drive the changelog and version.
- Keep PRs focused; one logical change per PR.

## Good first issues

Look for the `good-first-issue` label. If you want to pick up something larger,
open an issue first so we can align on approach before you write code.

## Tests

New behavior needs tests. Bug fixes should include a regression test.
