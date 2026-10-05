# Contributing to Argus

Thanks for your interest in Argus — _all-seeing runtime diagnostics for Node.js._

## Project shape

Argus is a single npm package. Its five modules live under `src/` (`agent`, `collector`,
`analyzer`, `dashboard`, `plugin-runner`) and are exposed as subpath exports such as
`argus/agent`. See `ARCHITECTURE.md` for how they fit together and `CLAUDE.md` for the hard rules.

## Getting set up

Argus uses **npm**. Use the Node version in `.nvmrc`.

```bash
npm install
npm run build           # dual build into dist/: ESM (dist/esm) + CJS (dist/cjs)
npm run check:exports   # after build: every `exports` subpath loads via import and require
npm run typecheck       # tsc --noEmit over src/ and the repo's own scripts and configs
npm test
npm run lint
npm run format:check
```

Run one module's tests with `npx vitest run src/<module>`. Commit
`package-lock.json` changes together with the `package.json` change that caused them.

Before committing:

```bash
npm run typecheck
npm test
npm run lint
npm run format        # or format:check in CI
```

## The rules that PRs are checked against

- **`src/agent` has zero external dependencies** and imports nothing from the other
  modules (an ESLint rule enforces both). A PR adding a third-party
  dependency to the agent will not be merged. Use Node core.
- TypeScript strict mode. No `any` without a comment explaining why.
- Streams use `stream/promises` `pipeline()`, never `.pipe()`.
- Worker Thread files live in `*/src/workers/`; no inline `eval`-based workers.
- `async_hooks` is imported only in `src/agent/context.ts`.
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

## Conduct and security

- This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md). By participating you are
  expected to uphold it.
- Found a vulnerability? **Do not open a public issue or PR.** Follow the private disclosure process
  in [`SECURITY.md`](./SECURITY.md).

By contributing, you agree your contributions are licensed under the repository's
[Apache 2.0 license](./LICENSE).
