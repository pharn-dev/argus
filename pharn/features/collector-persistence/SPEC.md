---
spec_id: collector-persistence
state: Draft
spec_content_hash: ''
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S2 (collector pipeline), final slice: opt-in disk persistence of recent aggregated windows.
The collector keeps closed windows only in an in-memory ring buffer, so a restart of the monitored process
loses every recent window exactly when a user diagnosing an incident needs the history. CLAUDE.md fixes the
decision: an in-memory ring buffer always, plus opt-in disk persistence of recent windows in an append-only
file, with no external database. A user who opts in gets the most recent windows back after a restart, a
crash that leaves a half-written line never stops the collector, and the file never grows without bound.
Without the option, the collector behaves exactly as today and touches no file.

## Scope

**In scope:**

- An opt-in persistence option on `createCollector` (for example `persist: { path, maxBytes }`); off by
  default, and when it is not configured no file is created, opened or read.
- Every closed window appended, in order, as one NDJSON line to an append-only file opened in append mode,
  honouring write backpressure.
- Restore on start: when persistence is configured and the file exists, the most recent `capacity` valid
  windows are loaded into the in-memory window ring before any new window; corrupt or truncated lines (for
  example a partial last line left by a crash) are skipped and counted in an integer `skipped` counter, and
  never crash the collector.
- Bounded disk use: when the file exceeds `maxBytes` it is compacted to only the last `capacity` windows by
  writing a temporary file and renaming it over the original, so a crash mid-compaction never loses the
  previous file.
- Write errors surfaced (rejecting `consume` or through an error callback), never swallowed.
- Validation at construction: a non-positive `maxBytes` or an empty `path` is rejected with an error that
  names the option.
- Everything exported from `src/collector/index.ts`, with vitest tests that use temporary directories.

**Out of scope (non-goals):**

- Persisting alerts, heap snapshots or raw agent samples; only aggregated windows are persisted.
- Any external database, compression, encryption, or a file format other than NDJSON.
- Time-based retention, multiple rotated files, or sharing one file between several collector processes.
- Any change to `src/agent`, the window aggregator's output, the alert evaluator or the alert sinks.

## Acceptance Criteria

- **AC-1** Given a temporary directory and a collector created from the collector entrypoint with
  `windowMs` 1000, capacity 10 and persistence pointing at a file path inside that directory, and a second
  collector created with the same options but no persistence option When each consumes a readable source of
  agent samples spanning three consecutive windows and the source ends Then the first collector's completion
  resolves and the file holds exactly the closed windows, one line each, every line parsing as JSON equal to
  the corresponding window in the collector's window ring in the same order; and the second collector's
  completion resolves and the temporary directory contains no file at all
  - verify: integration
- **AC-2** Given a file inside a temporary directory holding twelve valid window lines with one line that is
  not valid JSON between them, followed by a truncated partial line at the end When a collector is created
  from the collector entrypoint with capacity 10 and persistence pointing at that file, and it consumes a
  source spanning two more windows Then creation and consumption complete without throwing, the restore's
  `skipped` counter reads 2, and the window ring holds the last eight restored windows followed by the two
  new windows, in that order
  - verify: integration
- **AC-3** Given a collector created from the collector entrypoint with capacity 3 and persistence with a
  small `maxBytes` pointing at a file inside a temporary directory When it consumes a source spanning enough
  windows that the appended lines exceed `maxBytes` Then after completion every line of the file parses as
  JSON, the lines are a contiguous run of the consumed windows in order ending with the last closed window,
  the file holds fewer lines than the windows consumed, and no other file remains in the directory; and when
  the persistence path is a directory so the append fails Then `consume` rejects or the error callback is
  called with that error; and when a collector is created with `maxBytes` 0, `maxBytes` -1 or an empty
  `path` Then creation throws synchronously with a message that names `maxBytes` or `path` respectively
  - verify: integration

## Constraints

- `src/collector` uses Node core modules only (no third-party dependencies); `src/agent` never imports
  from `src/collector`.
- Stream composition uses `stream/promises` `pipeline()`, never `.pipe()`; every file and stream error is
  surfaced explicitly, never swallowed and never an unhandled rejection.
- The `skipped` counter and every byte count are integers.
- A collector created without the persistence option keeps its existing behaviour (the collector-windows,
  collector-alerts and collector-alert-sinks criteria still hold).
- Compaction never leaves the persisted file missing or partially written: the previous file stays intact
  until the rename replaces it.
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build must keep
  compiling.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these criteria, with per-test results
  already configured; the test stage's preflight decides whether that holds.
- `createCollector` stays synchronous; "restore on start" may happen either at construction or at the
  start of `consume` (before any new window is recorded), and the PLAN picks which and how the `skipped`
  counter is exposed on the collector (for example a `persistence.skipped` property).
- A line is valid when it parses as JSON with the integer fields of an aggregated window; anything else,
  including a non-empty final line without a trailing newline that fails to parse, counts as skipped. An
  empty trailing line after the final newline is not counted.
- Compaction is checked after appends, so the file may exceed `maxBytes` by at most the windows written
  since the last check; "never grows without bound" means compaction keeps it bounded, not that it never
  exceeds `maxBytes` by a single line.
- `maxBytes` must be a positive integer; a non-integer or non-number value is rejected the same way as a
  non-positive one.
- The file and its parent directory are not created for the user beyond creating the file itself in append
  mode; a missing parent directory is a write error surfaced like any other.
- Restored windows are placed into the ring only; they are not re-evaluated against alert rules and not
  re-delivered to sinks.
