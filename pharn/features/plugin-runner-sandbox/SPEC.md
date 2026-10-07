---
spec_id: plugin-runner-sandbox
state: Approved
spec_content_hash: 76472e01a4855b1dd01f7431f05eb385416f2c8115d1f75f35fe5c43e409e83d
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S6 (plugin runner), slice 1: the sandbox (FEATURES.md §6, "Rules execute in `isolated-vm`
with a hard memory limit and timeout"). Users want to write their own diagnostic rules, small pieces of
JavaScript such as "flag a window whose event-loop max exceeds 50ms", and run them against the aggregated
windows the collector already produces. Because that code is user-supplied, a rule that throws, loops
forever or allocates without bound must never crash, hang or block the process running the plugin runner:
it must come back as a typed error the caller can act on. `isolated-vm` needs `--no-node-snapshot` on Node
22 and later, so the isolate lives in a child process launched with that flag, and because `isolated-vm`
is a native optional dependency, a host where it is not installed must get a clear typed error rather than
a crash. The bundled rule library and the Node Permission Model are later slices.

## Scope

**In scope:**

- Running one user-supplied rule, given as JavaScript source, against one or more aggregated collector
  windows, and returning the rule's findings as plain JSON-serializable data.
- Executing the rule inside `isolated-vm` with a hard memory limit and a hard timeout, both configurable
  with finite defaults, in a child process launched with `execArgv` `['--no-node-snapshot']`.
- Typed errors, returned as data with a stable code, for a rule that throws, a rule that exceeds the
  timeout, a rule that exceeds the memory limit, a rule source that does not compile, and a host where
  `isolated-vm` cannot be loaded.
- `isolated-vm` 6.x declared as an optional peer dependency and as a devDependency; the root package keeps
  no runtime `dependencies`.
- The public API exported from the `argus/plugin-runner` entrypoint (`src/plugin-runner/index.ts`), with
  vitest tests.

**Out of scope (non-goals):**

- The bundled rule library (common leak / latency patterns).
- Applying the Node Permission Model to the agent or the child process.
- Wiring rule findings into collector alerts, alert sinks, the dashboard or SSE.
- Loading rules from files or a config directory, hot-reloading rules, or giving a rule any host API
  (no `require`, no filesystem, no network, no timers beyond what a bare isolate offers).
- Any change to `src/agent`, or any import of `src/plugin-runner` from `src/agent`.

## Acceptance Criteria

- **AC-1** Given a plugin runner created from the `argus/plugin-runner` entrypoint with `isolated-vm`
  installed, and a rule whose source returns one finding for every window whose event-loop max is above
  100 When the rule is run against three aggregated windows whose event-loop max values are 50, 500 and 50
  Then the run resolves with a success result whose findings list holds exactly one finding, that finding
  identifies the second window, and the result is JSON-serializable
  - verify: integration
- **AC-2** Given a plugin runner created from the `argus/plugin-runner` entrypoint with a timeout of 200ms
  and a memory limit of 16MB, and a host `setInterval` ticking every 10ms When it runs, one after another,
  a rule whose source throws `new Error('boom')`, a rule whose source is an infinite loop, a rule whose
  source keeps allocating until memory runs out, and a rule whose source is not valid JavaScript Then each
  run resolves (never rejects) with a failure result whose error code is respectively the rule-threw code
  with a message containing `boom`, the timeout code, the memory-limit code and the compile-error code,
  the infinite-loop run resolves within 2000ms, the host interval has kept ticking during the infinite-loop
  run, and a fifth run of the AC-1 rule afterwards on the same runner still resolves with a success result
  - verify: integration
- **AC-3** Given a plugin runner created from the `argus/plugin-runner` entrypoint in a setup where the
  sandbox child process cannot load `isolated-vm` When a rule is run Then the run resolves (never rejects)
  with a failure result whose error code is the isolated-vm-missing code and whose message names
  `isolated-vm` and says how to install it, and the host process is still running
  - verify: integration

## Constraints

- `src/agent` stays dependency-free and never imports from `src/plugin-runner`; the root `package.json`
  keeps no runtime `dependencies`; `isolated-vm` is an optional peer dependency (6.x) and a
  devDependency only.
- The isolate runs in a child process launched with `execArgv` `['--no-node-snapshot']`; the host process
  that calls the runner is never started with that flag and never loads `isolated-vm` itself.
- Every rule execution, child-process error and child exit is handled explicitly: no silent failure, no
  unhandled rejection, no crash of the host.
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build and
  `check:exports` must keep passing.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these criteria, with per-test results
  already configured; the test stage's preflight decides whether that holds.
- `isolated-vm` is not currently installed in `node_modules`; adding it as a devDependency (and to
  `package-lock.json`) is part of this increment, and it builds on the Node 22 toolchain used here.
- A rule's source is the body of a function, or a module-like script, that receives the windows as
  JSON-copied data and returns an array of findings; the PLAN fixes the exact rule contract, finding shape
  and exported names, and how a finding "identifies" a window (for example by the window's start time or
  index).
- "Error code" means a stable string field on the failure result, one per failure kind; the PLAN picks the
  exact strings.
- The isolated-vm-missing case (AC-3) is exercised through a test seam the PLAN provides, for example an
  option naming the module specifier the child loads; the real install is not removed in tests.
- A timeout or memory-limit failure may dispose the isolate or restart the child process; either is
  acceptable as long as the next run on the same runner succeeds (AC-2).
- The runner exposes a way to shut down its child process so tests and hosts exit cleanly.
