---
spec_id: agent-permission-model
state: Approved
spec_content_hash: 529e2e6294f821961c22f5ebaafac10898d1070e5b84133b1425849df25a47b5
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S6 item "Node Permission Model applied to the agent" (FEATURES.md §6: "Node Permission Model
constrains the agent"). Operators who lock a production Node.js process down with the Node Permission Model
(`--permission`) still need to drop in `argus/agent`. Today a denied file write the agent makes (the NDJSON
export to a file, or an on-demand heap snapshot) surfaces as Node's raw `ERR_ACCESS_DENIED`. The operator wants
the agent to run correctly under the permission model, to fail only the one feature whose write is denied with
a clear, typed Argus error while the host process keeps running, and to know the minimal set of grants the
agent needs.

## Scope

**In scope:**

- A small Node-core-only helper in `src/agent` that reports whether the permission model is active
  (`process.permission` is an object when it is, `undefined` when it is not) and checks
  `process.permission.has(scope, reference)` with the path resolved to an absolute path first.
- A typed, exported error class (for example `ArgusPermissionError`) carrying the denied scope and resource.
- Before the NDJSON export opens a file destination (`openAgentOutput`, used by auto-start), the agent checks
  `fs.write` for the absolute output path; when denied, the agent is disabled with the single existing
  `[argus] agent disabled: ...` stderr line and the host process keeps running.
- Before `takeHeapSnapshot` writes, it checks `fs.write` for the absolute snapshot path; when denied, it
  rejects with the typed error.
- The helper and the error class exported from the agent entrypoint (`src/agent/index.ts`).
- A documented minimal flag set (README or a docs section): `--permission --allow-fs-read=<app and
node_modules/argus>`, plus `--allow-fs-write=<NDJSON output file or its directory>` and
  `--allow-fs-write=<heap snapshot dir>` only for those features; and a statement that the agent spawns no
  worker threads or child processes, so it needs no `--allow-worker` or `--allow-child-process`.
- Integration tests that spawn a child Node process under `--permission` loading the agent, for both the
  granted and the denied path of each feature.

**Out of scope (non-goals):**

- Applying or enforcing permission flags on the user's behalf (the agent never re-launches the process).
- Permission handling in the collector, analyzer, dashboard or plugin runner.
- Network, worker, child-process, addon or WASI permission scopes for the agent (it uses none of them).
- Handling a denied `fs.read` of the agent's own files or of the config file beyond what the existing
  "agent disabled" reporting already does; the documented flag set grants those reads.
- Supporting the `--experimental-permission` flag name on Node 24, where it is not accepted.

## Acceptance Criteria

- **AC-1** Given the permission helper and the typed permission error imported from the agent entrypoint
  When the helper is called in a process without the permission model, and again with a stubbed
  `process.permission` whose `has` records its arguments and returns false, using a relative path Then
  without the permission model it reports the model inactive and the check returns allowed; with the stub
  it reports the model active, `has` received the scope and the absolute form of the relative path, and the
  check returns denied; and an instance of the typed error is an `Error` exposing the denied scope and
  resource as given
  - verify: unit
- **AC-2** Given a child Node process started with `--permission` and an fs-read grant for the app and the
  agent, whose agent configuration sends NDJSON output to a file, and which prints a marker on stdout after
  loading the agent and runs briefly When it runs once with `--allow-fs-write` granting the output file's
  directory and once with no fs-write grant Then with the grant the output file exists and contains at least
  one line that parses as JSON, and stderr carries no `[argus] agent disabled` line; without the grant the
  output file does not exist, stderr carries exactly one line starting `[argus] agent disabled:`, stdout
  carries the marker, and the child exits with code 0
  - verify: integration
- **AC-3** Given a child Node process started with `--permission` and an fs-read grant for the app and the
  agent, which calls `takeHeapSnapshot({ dir })` for an existing directory and prints the outcome as JSON on
  stdout When it runs once with `--allow-fs-write` granting that directory and once with no fs-write grant
  Then with the grant the call resolves with a `path` inside the directory that exists and ends in
  `.heapsnapshot`; without the grant the call rejects with an instance of the typed permission error whose
  scope is `fs.write` and whose resource is an absolute path inside that directory, no `.heapsnapshot` file
  is left in the directory, and the child exits with code 0
  - verify: integration

## Constraints

- `src/agent` imports Node core modules only (`node:` builtins): zero third-party dependencies, no imports
  from other `src/` modules, and no `async_hooks` import outside `src/agent/context.ts`.
- The agent spawns no worker threads and no child processes.
- No silent failures: a denied write is reported (the typed rejection, or the single `[argus] agent
disabled:` stderr line), never swallowed, and never crashes the host process.
- Works on Node 22.13 or later and Node 24 with `--permission`; without the permission model, behaviour of
  both features is unchanged.
- TypeScript strict mode, and the package's existing dual ESM/CJS build must keep compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for both unit and integration criteria, with
  per-test results; the test stage's preflight decides whether that holds.
- Integration tests spawn the child with the Node binary running the tests (Node 22.13+ or 24), so
  `--permission` is the flag used; the PLAN chooses whether the child loads the built `dist/` agent or a
  test-compiled copy of the sources, and grants fs-read for it.
- Per the increment's experiment facts on Node 22.19.0 and 24.13.1, `process.permission.has('fs.write',
<absolute path>)` is true for a granted directory and files under it, false otherwise, and an unknown
  scope returns false without throwing; a relative path must be resolved to absolute first.
- The exact names of the helper, its return shape and the error class's property names are left to the PLAN;
  the criteria only require them to be reachable from the agent entrypoint and to expose scope and resource.
- For the NDJSON export, the stdout destination (`output: 'stdout'`) needs no fs-write grant and is not
  checked.
- "The child exits with code 0" means the host script's own work completes and the process ends normally;
  the denied feature does not keep the process alive or crash it.
- Under `--permission`, an HTTP listen is not restricted on Node 22/24, so nothing in the agent depends on a
  net grant.
