---
spec_id: deopt-parsing
state: Approved
spec_content_hash: 5d64f0d2e6004d0dd168f8a42c0369b49dfee8f8851b21033b93ac3b47c6c822
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S5 (V8 / memory depth) item "`--trace-deopt` parsing", in `src/agent` (FEATURES.md:
"Deoptimization detection via `--trace-deopt` parsing."). A developer chasing a slow hot path needs to know
which functions V8 keeps deoptimizing, why, and where — but raw `--trace-deopt` output is a flood of
addresses and frame dumps whose shape also differs between Node 22 (V8 12.4, `<Code TURBOFAN>`) and Node 24
(`<Code MAGLEV>`, `<Code TURBOFAN_JS>`). This slice adds a pure, Node-core-only parser that turns that text,
line by line (as streamed from a child process or read from a captured log), into structured deopt events
and integer per-function counts, and never throws on input it does not understand.

## Scope

**In scope:**

- A line consumer that accepts `--trace-deopt` output one line at a time (so it can sit behind a line
  splitter in a Transform stream) and produces structured deopt events, plus a way to read the events and
  per-function aggregates collected so far.
- From each `[bailout (kind: …, reason: …): begin. deoptimizing … <JSFunction NAME (sfi = …)>, … <Code
  TIER>, …]` headline line: the function name (a fixed anonymous marker when V8 prints
  `<JSFunction (sfi = …)>`), the deopt kind, the bailout reason, and the code tier.
- From a `--trace-deopt-verbose` `;;; deoptimize at <URL:LINE:COLUMN>` position line that follows a
  headline: the script url and the integer line and column, attached to that headline's event; when the
  line also carries `inlined at <…>` positions, the first (innermost) position is the deopt location.
- `[marking dependent code … (… <SharedFunctionInfo NAME>) … for deoptimization, reason: …]` lines, as
  events carrying the function name and reason, distinguishable by kind from bailout events.
- Integer counts aggregated per function name.
- Lines that look like a deopt record but cannot be parsed are counted and skipped, never thrown.
- Exported from the agent entrypoint, Node core only, with vitest tests whose fixtures are copies of real
  Node 22 and Node 24 captures.

**Out of scope (non-goals):**

- Spawning a child process, setting V8 flags on the running process, or capturing its stderr.
- Wiring the parser into the sampler controller, the NDJSON exporter, the collector or the dashboard.
- Source-map resolution or stack-trace symbolization of the reported locations.
- Parsing `--trace-opt`, `--trace-ic` or any other V8 trace flag.
- Interpreting the frame-dump lines of `--trace-deopt-verbose` (register and stack slot contents).

## Acceptance Criteria

- **AC-1** Given the deopt parser imported from the agent entrypoint and the real plain `--trace-deopt`
  fixtures captured on Node 22 and Node 24 When every line of each fixture is fed to a fresh parser and the
  results are read Then the Node 22 fixture yields 6 bailout events and the Node 24 fixture yields 5, each
  with kind `eager`, a non-empty reason (including `not a Smi`, `wrong map` and `out of bounds` on both),
  the function name exactly as V8 printed it (`add`, `getX`, `arr`) or the anonymous marker, and no
  location; and the per-function counts are integers equal to the number of headlines naming that function
  (Node 22: anonymous 3, `add` 1, `getX` 1, `arr` 1; Node 24: anonymous 2, `add` 1, `getX` 1, `arr` 1)
  - verify: unit
- **AC-2** Given the deopt parser imported from the agent entrypoint and the real `--trace-deopt-verbose`
  fixtures captured on Node 22 and Node 24 When every line of each fixture is fed to a fresh parser and the
  results are read Then the bailout event count equals the number of `[bailout (` headline lines in that
  fixture (frame-dump lines naming other functions such as `require` add no events and no counts); the
  `add` event carries script url `/app/deopt.js`, line 1 and column 31; a headline followed by
  `;;; deoptimize at </app/lazy.js:6:18> inlined at </app/lazy.js:9:38>` carries line 6 and column 18; and
  the lazy fixtures' `[marking dependent code …]` lines yield events with their function names (`hot` with
  reason `code dependencies` on Node 22; `outer` and `hot` with reason
  `dependent field type constness changed` on Node 24) whose kind differs from `eager`
  - verify: unit
- **AC-3** Given the deopt parser imported from the agent entrypoint When it is fed a truncated headline
  (`[bailout (kind: deopt-eager, reason: wrong map): begin. deoptimizing`), a `;;; deoptimize at` line
  with no preceding headline, a malformed `[marking dependent code` line, an empty string, and then one
  valid headline from a real fixture Then no call throws, the unparseable-line count reads exactly 3, and
  the valid headline still yields one event with its function name, reason and an integer count of 1
  - verify: unit

## Constraints

- `src/agent` imports Node core modules only: zero third-party dependencies and no imports from other
  `src/` modules; no `async_hooks` import (reserved for the agent's context module).
- The parser is pure: no I/O, no timers, no global state shared between parser instances.
- All counts, line and column numbers are integers.
- No silent failures, but unparseable input is never an exception: it is counted.
- Must handle the output of both Node 22 (V8 12.4) and Node 24 as captured in the fixtures.
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build must keep
  compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these unit criteria, with per-test results;
  the test stage's preflight decides whether that holds.
- The fixtures are the path-sanitized captures supplied with the increment (node22.txt, node24.txt,
  node22-verbose.txt, node24-verbose.txt, lazy22-verbose.txt, lazy24-verbose.txt), copied into the repo by
  the PLAN; the counts in the criteria are taken from those files as supplied.
- Kind is reported without V8's `deopt-` prefix (`deopt-eager` becomes `eager`, and likewise `lazy` and
  `soft`); the captures contain only `deopt-eager` headlines, so `lazy` and `soft` are parsed by the same
  rule but not separately fixture-tested.
- "Unparseable" means a line that starts like a deopt record (`[bailout (`, `[marking dependent code`,
  `;;; deoptimize at`) but does not match its shape, or a position line with no headline to attach to; an
  empty string is not counted. Every other line (frame dumps, `[bailout end. took … ms]`, program output)
  is ignored without being counted, because verbose output is mostly frame dumps.
- Aggregation is per function name; all anonymous functions share the anonymous marker's count.
- The exact exported names, the anonymous marker's spelling, the kind value for marking-dependent-code
  events, and whether events are emitted per line or read on demand are left to the PLAN; the criteria
  only require them to be reachable from the agent entrypoint and stable.
