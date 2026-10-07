---
spec_id: example-worker-pool
state: Approved
spec_content_hash: c605d6eb8de99aeed66a62dc386a3a68cfa2fc974181285f3fc6773150c8de40
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S5 ("`examples/worker-pool` wired up") and FEATURES.md §10 ("`examples/worker-pool` — Worker
Threads scenario"). The repo has no `examples/` directory yet, so a user evaluating Argus has no runnable
proof that the agent, the on-demand heap snapshot and the analyzer worker pool work together from the
published package. This increment adds a small runnable example app that loads the Argus agent with one
line, does CPU-heavy work on Worker Threads, takes an on-demand heap snapshot, analyzes it on the Argus
analyzer worker pool without blocking the main event loop, and prints a short summary; plus a README with
run instructions and an integration test that runs the example as a child process against the built
`dist`.

## Scope

**In scope:**

- A runnable example under `examples/worker-pool/` that loads the agent with a single import of
  `argus/agent`, runs CPU-heavy work on Worker Threads (worker files in a `workers/` subdirectory, never
  inline or `eval`-based), takes an on-demand heap snapshot through the agent's exported API, analyzes it
  through the `argus/analyzer` heap-snapshot summary on the analyzer worker pool, shows that the main event
  loop kept running during the analysis, prints a short summary, and exits cleanly.
- The example imports Argus only through the package's own `exports` subpaths (`argus/agent`,
  `argus/analyzer`, …), which resolve to the built `dist`, never to `src`.
- A README in `examples/worker-pool/` with run instructions (build first, then the command that runs the
  example).
- An integration test that uses the built `dist` (building it if needed) and runs the example as a child
  process, asserting on its output and a clean exit.

**Out of scope (non-goals):**

- `examples/express-app`, the dashboard, the collector, the plugin runner or tracing in the example.
- Heap-snapshot diffing, stack symbolization or allocation sampling in the example.
- Any change to the behaviour of `src/` modules or to the package's `exports` map.
- Publishing the example as its own npm package or adding any dependency.

## Acceptance Criteria

- **AC-1** Given the package has been built into `dist` When the integration test runs the
  `examples/worker-pool` entry as a child process with Node and waits for it to finish within a bounded
  timeout Then the process exits with code 0, its stderr contains no `[argus] agent disabled` line, and its
  stdout contains a summary line reporting that the CPU-heavy Worker Thread tasks completed, with the
  number of tasks as a positive integer
  - verify: integration
- **AC-2** Given the same built package and child-process run as in AC-1 When the run finishes Then its
  stdout contains a heap-snapshot analysis summary reporting a node count and a total self size that are
  positive integers and at least one top entry name, and a line reporting how many times the main event
  loop ticked while the analysis ran, with a count of at least 1
  - verify: integration
- **AC-3** Given the files under `examples/worker-pool/` When the integration test reads them Then every
  import of Argus in the example's source files uses a bare `argus/<subpath>` specifier (none points into
  `src/` or `dist/` by relative or absolute path), and a README file exists there whose text contains
  `npm run build` and the command that runs the example
  - verify: integration

## Constraints

- The example and its test use Node core modules and the `argus` package only: no new dependencies, and the
  root `package.json` keeps no runtime `dependencies`.
- The agent is loaded with one line (`import 'argus/agent'` or `require('argus/agent')`).
- Worker Thread files live in a `workers/` subdirectory; no inline or `eval`-based workers.
- Every worker, stream and promise in the example has explicit error handling: no silent failures, no
  swallowed or unhandled rejections; a failure makes the example exit non-zero with a message on stderr.
- The example writes any heap snapshot into a temporary directory and removes it before exiting.
- Node 22 or later; the existing `npm run build`, `check:exports`, `typecheck`, `lint`, `format:check` and
  `test` gates keep passing, and every new file is Prettier-formatted.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these criteria, with per-test results already
  configured; the test stage's preflight decides whether that holds. Its `include` currently covers only
  `src/**/*.test.ts`, so where the integration test lives, or whether the include is widened, is a PLAN
  decision.
- The package self-reference (`argus/<subpath>` resolved through the root `package.json` `exports` from a
  file inside the repo) is how the example reaches `dist`; no `npm link` or install step is needed.
- The agent's default output is NDJSON on stdout; the example's summary lines must be distinguishable from
  it (for example by a fixed prefix), or the example or test may set `ARGUS_OUTPUT` so the agent writes
  elsewhere. Which one is a PLAN decision, but the agent must still be loaded and enabled.
- Whether the example is plain JavaScript (ESM or CJS) or TypeScript run through Node's type stripping, the
  exact entry file name, the summary wording, the number of CPU tasks and the kind of CPU work are PLAN
  decisions; the run command named in the README must match what the test runs.
- "The main event loop kept running" is shown by a timer on the main thread that counts its ticks while the
  analysis runs; the timer interval is a PLAN decision.
- The integration test may run `npm run build` itself when `dist` is missing or stale, or rely on a build
  done earlier in the same test run; either satisfies "uses dist" as long as the example resolves to `dist`.
