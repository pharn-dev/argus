---
spec_id: plugin-runner-rule-library
state: Approved
spec_content_hash: 2a6a43fac113477b6067e76af3f3c22eba584fdbf43ceb203ffb14945a660e35
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S6 (plugin runner), slice 2: the bundled rule library of common leak and latency
patterns. The sandbox slice already runs one user-supplied rule source against aggregated collector
windows and returns findings or a typed error. Users want useful rules out of the box without writing
any: sustained event-loop lag above a threshold, heap growth across consecutive windows, and GC pause
share above a threshold. Each built-in rule is shipped as rule source that runs through the existing
sandbox, has a stable rule id, and takes typed, validated parameters. Users also want to drop their own
rules into a directory of `.js` files and have them run alongside the built-in ones, with one failing
rule never affecting the others.

## Scope

**In scope:**

- Three built-in rules, each with a stable rule id, typed parameters with defaults, and rule source that
  runs through the existing plugin-runner sandbox: sustained event-loop lag (the event-loop max is above a
  threshold for at least N consecutive windows), heap growth (heap used rises across at least N
  consecutive windows), and GC pause share (GC total pause as a share of the window duration is above a
  threshold).
- Validation of each built-in rule's parameters before any run, with a typed error naming the rule id and
  the offending parameter.
- A helper that reads every `.js` file in a given directory once, as text, and treats each as a user rule
  whose id is derived from its file name, without `require`, `import` or `eval` of that file in the host
  process.
- A helper that runs a chosen set of built-in rules plus user rules over a list of collector windows and
  returns one result per rule, keyed by rule id: that rule's findings, or that rule's typed error.
- The public API exported from the `argus/plugin-runner` entrypoint (`src/plugin-runner/index.ts`), with
  vitest tests.

**Out of scope (non-goals):**

- Wiring rule findings into collector alerts, alert sinks, the dashboard or SSE.
- Watching the rules directory or hot-reloading rules.
- Any rule beyond the three named above, and any change to the sandbox's limits or error codes beyond
  what the new helpers need.
- Applying the Node Permission Model.
- Any change to `src/agent`, or any import of `src/plugin-runner` from `src/agent`.

## Acceptance Criteria

- **AC-1** Given the built-in rules exported from the `argus/plugin-runner` entrypoint, run with their
  default or explicitly given parameters through a plugin runner with `isolated-vm` installed, and a list
  of aggregated windows in which a run of consecutive windows has an event-loop max above the lag
  threshold, a run of consecutive windows has strictly rising heap used, and one window has a GC total
  pause share above the GC threshold When the run-all helper is called with all three built-in rules over
  those windows Then it resolves with one success result for each of the three stable rule ids, each
  holding findings that identify exactly the windows the matching pattern covers, and a second list of
  windows matching none of the patterns yields success results with empty findings for all three ids
  - verify: integration
- **AC-2** Given the built-in rules exported from the `argus/plugin-runner` entrypoint When a built-in
  rule is configured with an invalid parameter (a negative threshold, a non-integer or zero window count,
  or a parameter of the wrong type) Then the configuration returns or throws a typed error with a stable
  invalid-parameter code that names the rule id and the parameter, and no sandbox run is started for it
  - verify: integration
- **AC-3** Given a temporary directory holding one valid user rule `.js` file that returns one finding,
  one `.js` file whose source throws, one `.js` file whose source is not valid JavaScript, and one non-`.js`
  file When the directory is loaded with the rules-directory helper and the loaded rules are run together
  with the three built-in rules through the run-all helper over the AC-1 windows Then exactly three user
  rules are loaded, with ids derived from their file names, the run resolves (never rejects) with the
  valid user rule's finding, the rule-threw code for the throwing rule, the compile-error code for the
  invalid rule, and the same three built-in success results as AC-1, and none of the user rule files was
  executed in the host process
  - verify: integration

## Constraints

- `src/agent` stays dependency-free and never imports from `src/plugin-runner`; the root `package.json`
  keeps no runtime `dependencies`; built-in and user rules execute only inside the existing sandbox.
- User rule files are read once as text with `node:fs`; the host never `require`s, `import`s or `eval`s
  them.
- Every rule run and every file read is handled explicitly: one rule's failure is returned as that rule's
  typed error and never rejects the whole run or hides the other rules' results.
- Built-in rule thresholds compare integers (nanoseconds, bytes, counts), and shares are computed with
  integer math (for example per-mille), not floats.
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build and
  `check:exports` must keep passing.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these criteria, with per-test results
  already configured; the test stage's preflight decides whether that holds.
- A user rule file's content uses the same rule contract as the sandbox slice (a function body receiving
  `windows` and returning findings); a rule's id is its file name without the `.js` extension.
- Built-in rules are exposed as configurable descriptors (for example a function per rule taking its
  parameters and returning `{ id, source }`); the PLAN fixes the exact names, rule ids, default values and
  how parameters reach the rule source.
- The invalid-parameter error is a stable string code alongside the existing rule error codes; the PLAN
  picks the exact string and whether configuration throws it or returns it as data.
- GC pause share is GC total pause divided by window duration (`end - start`), both converted to one unit,
  expressed in per-mille; heap growth compares `memory.heapUsedLast` across consecutive windows.
- Reading a directory that does not exist, or a file that cannot be read, is reported as a typed error
  rather than a crash; the exact shape is left to the PLAN.
- Rules run sequentially through one plugin runner, which the caller supplies and closes.
