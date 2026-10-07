# Contributing to Argus

Thanks for your interest in Argus — _all-seeing runtime diagnostics for Node.js._

## Project shape

Argus is a single npm package. Its six modules live under `src/` (`agent`, `collector`,
`analyzer`, `dashboard`, `plugin-runner`, `otel`) and are exposed as subpath exports such as
`argus/agent`. See `ARCHITECTURE.md` for how they fit together and `CLAUDE.md` for the hard rules.

## Getting set up

Argus uses **npm**. Use the Node version in `.nvmrc` (22.18.0, the supported floor; `engines.node`
is `>=22.18.0`).

```bash
npm install
npm run build           # dual build into dist/: ESM (dist/esm) + CJS (dist/cjs)
npm run check:exports   # after build: every `exports` subpath loads via import and require
npm run check:package   # after build: tarball contents, source maps, and engines.node == .nvmrc
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

## What CI checks

Every PR runs these as separate jobs, and all of them are required status checks on `main`:

| Job          | Command                                                                |
| ------------ | ---------------------------------------------------------------------- |
| Format check | `npm run format:check`                                                 |
| Lint         | `npm run lint`                                                         |
| Typecheck    | `npm run typecheck`                                                    |
| Test         | `npm test`                                                             |
| Build        | `npm run build`, `npm run check:exports`, then `npm run check:package` |
| Action pins  | `npm run check:pins` (every Action pinned to a SHA)                    |

Every required job runs on the Node version in `.nvmrc`, which is the `engines` floor.

CodeQL (`Analyze (javascript-typescript)`) and `gitleaks` run as well. A separate, non-required
`node-latest` workflow smoke-tests Node 24. The job names are a contract with the branch ruleset:
renaming one means updating the ruleset too.

A `nightly` workflow, not a PR check, runs `node bench/overhead.mjs` (agent-on versus agent-off;
informational, tables in the job summary) and `node bench/soak.mjs` (fails on heap growth or leaked
workers and child processes). See `bench/README.md`.

## Threat model and limits

Argus's own security design is in [`docs/THREAT-MODEL.md`](./docs/THREAT-MODEL.md) and its
limits in [`docs/LIMITS.md`](./docs/LIMITS.md). A change that adds a network listener, a place data
is written or sent, or parsing of untrusted input needs a row in the threat model in the same PR.
(The `THREAT-MODEL.md` and `LIMITS.md` at the repo root belong to the PHARN development tooling,
not to Argus. They stay at the root because the PHARN installer, its write-guard hook and its drift
records expect them there; `.gitattributes` marks them, `pharn/` and `.claude/` as vendored, and
none of it ships in the package.)

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
- The agent must not measurably slow the monitored process. A PR that touches a hot path (the
  HTTP `emit` wrapper, the stream `write` wrappers, the samplers, the NDJSON exporter) includes
  before and after tables from `node bench/overhead.mjs` (run `npm run build` first).

## Commits & releases

- **Conventional Commits** (`feat:`, `fix:`, `chore:`, …). PRs are squash-merged, so the PR title
  becomes the commit message on `main` — write it in that style.
- Add a line under **Unreleased** in `CHANGELOG.md` for any user-visible change.
- Releases are cut by a maintainer by hand (version bump, GitHub Release, npm publish through CI):
  see [`docs/RELEASING.md`](./docs/RELEASING.md).
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
