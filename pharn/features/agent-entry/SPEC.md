---
spec_id: agent-entry
state: Approved
spec_content_hash: f9fb4eb821cf3236522db36cfc728ad3330b322e01616d51e01c36837931e91e
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S1 (agent core), final slice: the one-line entry (FEATURES.md §1). A developer diagnosing a
Node.js process wants to turn Argus on with one line, `require('argus/agent')` or `import 'argus/agent'`, or
with no source edit at all through `node --require argus/agent app.js` / `node --import argus/agent app.mjs`.
Loading that entry should start the agent once per process from its configuration and stream combined
samples as NDJSON to the configured output, without ever keeping the host process alive and without ever
crashing it. The pieces (config loader, sampler controller, NDJSON exporter) already exist; this slice wires
them behind the package's `argus/agent` export.

## Scope

**In scope:**

- Loading the `argus/agent` entry starts the agent once per process: config is loaded from `process.cwd()`
  and `process.env`, and when enabled a sampler controller's samples go to an NDJSON exporter writing to
  the configured output (a file path opened in append mode; `stdout` written to `process.stdout`, which is
  never ended; `none` writes nothing).
- The entry still exposes the existing library exports; loading it for its API also starts the agent, and
  `ARGUS_ENABLED=0` turns that off.
- Exactly-once: loading the entry several times in one process, including once as CommonJS and once as
  ESM, runs a single agent, guarded by a process-wide symbol (for example
  `globalThis[Symbol.for('argus.agent')]`).
- Never keeps the process alive, and never crashes the host: a config error or an output error is
  reported once on stderr with an `[argus]` prefix and the agent stays off, with no unhandled rejection
  and no error thrown out of the require or import.
- Package wiring: the `./agent` export, under both its `import` and `require` conditions, points at the
  auto-start entry; `npm run build` and `npm run check:exports` keep passing.
- Vitest tests that spawn real child Node processes against the built entry.

**Out of scope (non-goals):**

- The dashboard, SSE endpoint and collector side (ROADMAP S2/S3).
- A programmatic stop/start API for the auto-started agent, and flushing remaining samples at exit.
- Request tracing, AsyncLocalStorage context and any `async_hooks` use.
- Changing the config schema, the sampler controller or the NDJSON exporter's behavior.

## Acceptance Criteria

- **AC-1** Given the built package and an app script that keeps itself busy for about ten sampling
  intervals and then lets its event loop empty When the app is run as a child process once with
  `node --require argus/agent`, once with `node --import argus/agent`, each with `ARGUS_OUTPUT` set to a
  temp file and a short `ARGUS_INTERVAL_MS`, and once with `--require argus/agent` and
  `ARGUS_OUTPUT=stdout` Then every child exits on its own with code 0 and nothing on stderr; each temp
  file holds at least one line, every line parsing as JSON with an integer `timestamp` and `eventLoop`,
  `memory`, `gc` and `backpressure` parts; and the stdout run prints at least one such sample line and
  still prints the app's own last `console.log` line after its samples
  - verify: integration
- **AC-2** Given the built package and an app script, preloaded with `--require argus/agent`, that also
  loads `argus/agent` twice with `require()` and once with `import()` and prints whether
  `loadAgentConfig`, `createSamplerController` and `createNdjsonExporter` are functions on both module
  objects When it runs as a child process with `ARGUS_OUTPUT` set to a temp file and a short
  `ARGUS_INTERVAL_MS`, and again with `ARGUS_ENABLED=0` added Then both children exit with code 0 and print
  `true` for every export; in the first run the temp file holds at least two samples and no two sample
  timestamps are closer together than half the interval (one agent, not several); and in the
  `ARGUS_ENABLED=0` run the temp file is absent or empty
  - verify: integration
- **AC-3** Given the built package and an app script that prints `app ran` and exits When it runs as a
  child process with `--require argus/agent` once with an invalid config (`ARGUS_INTERVAL_MS=abc`) and
  once with an unusable output (`ARGUS_OUTPUT` pointing into a directory that does not exist), and the
  same two runs with `--import argus/agent` Then every child exits with code 0, its stdout contains
  `app ran`, and its stderr holds exactly one line starting with `[argus]` and no `UnhandledPromiseRejection`
  or stack trace text
  - verify: integration

## Constraints

- `src/agent` imports Node core modules only: zero third-party and zero workspace dependencies.
- No `async_hooks` import (reserved for the agent's context module).
- Dual package: the `./agent` export resolves for both `import` and `require`, from the existing
  `dist/esm` and `dist/cjs` builds; TypeScript strict mode; Node 22 or later.
- The agent's timer never keeps the process alive, and the agent never ends `process.stdout`.
- Nothing the entry does at load time may throw out of the `require`/`import` or leave an unhandled
  rejection.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these integration criteria, with per-test
  results already configured; the test stage's preflight decides whether that holds.
- Tests run against the built `dist/` output; whether the test suite builds first (for example in a
  global setup) or relies on a prior `npm run build` is left to the PLAN. The child process resolves
  `argus/agent` through the package's own `exports` (self-reference from a script inside the package, or
  an equivalent path), chosen by the PLAN.
- "Reported once on stderr" means one `[argus]`-prefixed line per failure; the exact wording is left to
  the PLAN.
- An output error is any failure to open or write the configured file (for example a missing directory);
  the agent turns itself off after reporting it, and samples already lost are not retried.
- Samples still queued when the process exits may be lost; flushing at exit is out of scope.
- Whether the library entry and the auto-start entry are one module or the auto-start entry re-exports
  the library is left to the PLAN, as long as `argus/agent` both starts the agent and exposes the existing
  exports.
- Under `ARGUS_ENABLED=0` no output file is created; if the PLAN opens it lazily that already holds.
