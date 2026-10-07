---
spec_id: example-worker-pool
spec_content_hash: c605d6eb8de99aeed66a62dc386a3a68cfa2fc974181285f3fc6773150c8de40
applied_lessons: none
---

## Approach

> ADVISORY: model work, derived from the Approved SPEC. Nothing here is floor-checked except the `## Files`
> list (the build's writes-scope) and the `applied_lessons` declaration.

Add a plain-JavaScript ESM example under `examples/worker-pool/` (no `package.json` of its own), so that
`argus/<subpath>` imports in it resolve through the **package self-reference** of the root `package.json`
(`"name": "argus"` plus its `exports` map) to the built `dist/esm/...` files. Plain `.mjs` is chosen over
TypeScript on purpose: the root `tsconfig.json` includes `**/*.ts`, so a `.ts` example would make
`npm run typecheck` resolve `argus/*` types from `dist/` and fail on a fresh clone before a build; `.mjs` files
are linted by the existing `**/*.{js,mjs,cjs}` ESLint block (type-checked rules disabled) and formatted by
Prettier, and are not part of `tsc`.

The entry `examples/worker-pool/index.mjs`:

1. `import 'argus/agent';` as its first line (the one-line agent load; the agent auto-starts and, by default,
   writes NDJSON samples to stdout; its sampler timer is `unref()`'d so it does not keep the process alive).
   `takeHeapSnapshot` comes from a second named import of the same specifier
   (`import { takeHeapSnapshot } from 'argus/agent';`, exported through `auto.ts`'s `export *`), and
   `createHeapSnapshotPool` / `summarizeHeapSnapshot` from `argus/analyzer`.
2. Runs `CPU_TASKS = 4` CPU-heavy tasks concurrently, each on its own `node:worker_threads` `Worker` built from
   `new URL('./workers/cpu-task.worker.mjs', import.meta.url)` (a real file, never `eval: true`). Each task
   counts the primes below a fixed bound (e.g. `200_000`) by trial division and posts the count back. Each task
   promise rejects on the worker's `error` event, on `messageerror`, and on `exit` with a non-zero code or
   before a result arrived; it resolves only on a well-formed numeric result message. Then it prints
   `[worker-pool] cpu tasks completed: 4` (the number is the count of fulfilled tasks).
3. Creates a temporary directory with `fs.promises.mkdtemp(path.join(os.tmpdir(), 'argus-worker-pool-example-'))`
   and takes a heap snapshot into it with `takeHeapSnapshot({ dir })`.
4. Creates one analyzer pool with `createHeapSnapshotPool({ size: 1 })`, starts a main-thread
   `setInterval(() => { ticks += 1; }, 1)` immediately before calling
   `summarizeHeapSnapshot(snapshot.path, { pool, top: 5 })`, and clears the interval in a `finally` once the
   analysis settles (so ticks are counted only while the analysis ran).
5. Prints, each on its own line with the fixed `[worker-pool] ` prefix so the lines are distinguishable from the
   agent's NDJSON on the same stdout:
   - `[worker-pool] heap snapshot: nodes=<nodeCount> totalSelfSize=<totalSelfSize>`
   - `[worker-pool] heap top: <name> count=<count> selfSize=<selfSize>` — one line per `summary.top` entry
     (at least one is expected in any real snapshot; if `top` is empty the example throws, so the run fails
     loudly instead of printing a summary with no entry)
   - `[worker-pool] event loop ticks during analysis: <ticks>`
   - `[worker-pool] done` as the last line
6. Cleanup in `finally` blocks, in order: clear the interval, `await pool.close()`, then
   `await fs.promises.rm(dir, { recursive: true, force: true })`. A cleanup failure is reported, never ignored.
7. Error handling: the whole flow is one `async function main()`; the module ends with
   `main().catch((err) => { process.stderr.write(\`[worker-pool] failed: ${message}\n\`); process.exitCode = 1; });`
   (no bare `process.exit()`, so stdout drains). A cleanup error after a primary error is appended to the same
   stderr report rather than replacing it. No promise is left un-awaited.

The example exits on its own: the agent's sampler timer is unref'd, idle analyzer workers are unref'd and the
pool is closed, the CPU workers have exited, and the tick interval is cleared.

A README in the example directory documents the two commands from the repo root: `npm run build`, then
`node examples/worker-pool/index.mjs`, plus a short "what you'll see" section listing the `[worker-pool]` lines
and noting that the interleaved JSON lines are the agent's NDJSON samples (set `ARGUS_OUTPUT=none` to silence
them, or a file path to redirect them).

### How the integration tests reach the built `dist` (for `/pharn-test`; advisory)

The tests live under `src/analyzer/` because `vitest.config.mts` only includes `src/**/*.test.ts`, and the
runner config is test infrastructure that this feature may not change. They run the example with
`process.execPath` and `cwd` = the repo root, and an env copied from `process.env` with every `ARGUS_*` variable
removed (so the agent runs with its defaults and stays enabled).

AC-1 and AC-2 each need a fresh `dist`. Each of those two test files, in `beforeAll` (timeout raised to
cover a build, e.g. 180 s):

- treats `dist` as fresh when `dist/esm/agent/auto.js`, `dist/esm/analyzer/index.js` and
  `dist/esm/analyzer/workers/heap-snapshot.worker.js` exist and none of the non-test `src/**/*.ts` files is newer
  (mtime) than the oldest of them;
- otherwise runs `node scripts/build.mjs` (what `npm run build` runs), serialized across the two test files —
  vitest runs files in parallel and `scripts/build.mjs` starts with `rm -rf dist` — by an exclusive lock
  directory created with `fs.mkdirSync` under `os.tmpdir()` (a name derived from the repo root path), polled with
  a bounded wait, removed in `finally`; the freshness check is repeated after the lock is taken.

AC-3 reads files only and needs no build.

## Applied lessons

- none — `check-lessons-index.mjs --verdict` printed `NO_CANON`: this project has no
  `memory-bank/lessons-learned.md` yet, so there are no promoted lessons to apply.

## Steps

- Create `examples/worker-pool/workers/cpu-task.worker.mjs`: reads `workerData` (`{ limit }`), validates it is a
  positive safe integer (throws otherwise, which surfaces as the worker's `error` event), counts primes below
  `limit` with integer trial division, and posts `{ primes }` to `parentPort` (throwing if `parentPort` is null).
- Create `examples/worker-pool/index.mjs` as described in the Approach: agent import first, CPU tasks, heap
  snapshot into a temp dir, analysis on the analyzer pool with the tick counter, summary lines, cleanup, and the
  single `main().catch(...)` error path that sets `process.exitCode = 1`.
- Create `examples/worker-pool/README.md` with the build and run commands and the expected output.
- Run `npx prettier --write` (or `node node_modules/prettier/bin/prettier.cjs --write`) on each of the three files,
  named one by one.
- Check locally: `npm run build`, then `node examples/worker-pool/index.mjs` exits 0 and prints the five kinds of
  `[worker-pool]` lines; then `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm run check:exports`,
  `npm test`.

## Files

- `examples/worker-pool/index.mjs` — the runnable example entry: one-line agent import, CPU tasks on Worker
  Threads, on-demand heap snapshot in a temp dir, analysis on the analyzer pool with a main-thread tick counter,
  `[worker-pool]` summary lines, cleanup and explicit error handling
- `examples/worker-pool/workers/cpu-task.worker.mjs` — the CPU-heavy Worker Thread file (prime counting), in a
  `workers/` subdirectory
- `examples/worker-pool/README.md` — run instructions (`npm run build`, then `node examples/worker-pool/index.mjs`)
  and the expected output

### Explicitly not touched

- `src/**` — no behaviour change to any module (SPEC non-goal); the AC tests under `src/analyzer/` are written by
  `/pharn-test` and are listed only in `AC-TESTS.md`
- `package.json` — `exports` map unchanged, no dependency added, no script added
- `vitest.config.mts`, `tsconfig*.json`, `eslint.config.mjs`, `prettier.config.mjs`, `scripts/**` — test and build
  infrastructure, unchanged
- `examples/worker-pool/package.json` — deliberately not created: a package scope there would break the
  `argus/<subpath>` self-reference to the root package
- `examples/express-app/**`, `ROADMAP.md`, `FEATURES.md`, `CHANGELOG.md`, `README.md` — out of scope

## Acceptance mapping

- AC-1 → the built `dist` plus `node examples/worker-pool/index.mjs` exits 0; the agent loads through
  `import 'argus/agent'` with default config and does not report `[argus] agent disabled`; stdout carries
  `[worker-pool] cpu tasks completed: 4`, a positive integer, after all four CPU workers reported.
- AC-2 → the same run prints `[worker-pool] heap snapshot: nodes=<int> totalSelfSize=<int>` (both from
  `summarizeHeapSnapshot`, positive integers for any real snapshot), at least one `[worker-pool] heap top: <name> …`
  line, and `[worker-pool] event loop ticks during analysis: <int>` — ticks counted by a 1 ms main-thread interval
  that runs only while the analysis runs on the analyzer worker, so a non-blocked loop gives at least 1.
- AC-3 → every source file under `examples/worker-pool/` imports Argus only as `argus/agent` / `argus/analyzer`
  (bare specifiers); the only other specifiers are `node:` builtins (the worker URL is a relative `new URL(...)`,
  not an import into `src/` or `dist/`); `examples/worker-pool/README.md` contains `npm run build` and
  `node examples/worker-pool/index.mjs`, the same command the tests run.

## Risks & open questions

- Tick count of at least 1 depends on the analysis taking longer than ~1 ms of wall time. Spawning the analyzer
  worker and parsing a multi-megabyte snapshot takes tens of milliseconds, so this is comfortably met; if it ever
  flakes, the fix is in the example (start the interval before creating the pool), not in the test.
- Worker file location: the SPEC asks for a `workers/` subdirectory; `CLAUDE.md` phrases the convention as
  `*/src/workers/`. The example has no `src/` (it is not a package module), so `examples/worker-pool/workers/` is
  used; `/pharn-grill` may prefer `examples/worker-pool/src/workers/`, which would also change the run command.
- `dist` freshness is decided by mtimes in the tests; a stale-but-newer `dist` (e.g. built from another branch,
  then checked out) could be reused. The gate sequence's own `npm run build` normally runs first, so this is a
  narrow residual.
- The agent writes NDJSON to the same stdout as the summary lines. Ordering between the two writers is not
  asserted; the tests match `[worker-pool] ` lines by regex with the multiline flag.
- The heap snapshot of a small process is still several MB written to `os.tmpdir()`; it is removed in `finally`.
