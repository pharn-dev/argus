---
spec_id: stack-symbolization
state: Approved
spec_content_hash: d83148099884b06c86741bfbfdcad9d356f6144739ab2810aa704694c1dea82a
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S5, the stack symbolization slice: FEATURES.md "Stack-trace symbolization (runs in a Worker
Thread)". A developer reading a stack trace from a monitored process that runs built JavaScript (for example
TypeScript compiled to `dist/`) sees positions in the built files, which are hard to act on at 2am. They want
each stack frame mapped back to the original source file, line and column using the source maps that ship
with the build, without adding a third-party dependency and without blocking the caller's event loop: the
mapping runs as a task on the existing analyzer worker pool. A frame that has no source map is returned as
given, and one broken source map only affects the frames of its own file.

## Scope

**In scope:**

- An analyzer function, exported from `src/analyzer/index.ts`, that takes a list of stack frames (each a
  file URL plus a line and a column) and resolves with the same number of frames in the same order, each
  mapped to its original source file, line and column where a source map covers it.
- Source maps found either inline in the built file (a `sourceMappingURL` comment carrying a base64 `data:`
  URL) or in an adjacent `.map` file named by that comment.
- Parsing the maps with Node core `node:module`'s `SourceMap` (the parser `findSourceMap` returns), so no
  third-party dependency is added.
- The mapping runs as a task on the analyzer worker pool, in a worker file under `src/analyzer/workers/`,
  never on the caller's event loop; the caller may pass its own pool, as the heap snapshot functions allow.
- A frame whose file has no source map, or whose position the map does not cover, is returned unchanged.
- A malformed source map produces a typed error attached to that file's frames only; the other frames in
  the same call are still mapped and the call still resolves.

**Out of scope (non-goals):**

- Parsing raw `Error.stack` strings into frames; the input is already structured frames.
- Fetching source maps over HTTP or from any location other than an inline `data:` URL or a local file.
- Mapping function names, returning `sourcesContent`, or rendering source code excerpts.
- Symbolizing native or V8 internal frames (`node:` builtins, `<anonymous>`, `native`), which are returned
  unchanged.
- Caching parsed source maps across calls, and wiring symbolization into the dashboard or the agent.

## Acceptance Criteria

- **AC-1** Given a built JavaScript fixture file with an adjacent `.map` file, a second built fixture file
  with an inline base64 `data:` URL source map, and a third JavaScript file with no source map, each
  with known original positions When the symbolization function, imported from the analyzer entrypoint,
  is awaited with frames (file URL, line, column) pointing into all three files plus a `node:internal`
  frame Then it resolves with one frame per input frame in the same order; the frames into the first two
  files carry the original source file, line and column the fixture maps record for those positions; and
  the frames into the third file and the `node:internal` frame are deeply equal to the input frames
  - verify: integration
- **AC-2** Given one built fixture file whose adjacent `.map` file is not a valid source map (invalid JSON)
  and one built fixture file with a valid source map When the symbolization function is awaited with a
  frame into each file Then the call resolves rather than rejects; the frame into the valid file carries
  its original source position; and the frame into the malformed-map file keeps the input file, line and
  column and carries an error whose `name` and `code` identify a malformed source map and whose message
  names that file
  - verify: integration
- **AC-3** Given an analyzer worker pool created for symbolization and then closed When the symbolization
  function is called with a valid frame and that closed pool passed as its pool option, and separately
  called with a frames argument that is not an array Then neither call throws synchronously; the first
  rejects with the analyzer's `WorkerPoolClosedError`, showing the task is routed through the given pool;
  and the second rejects with a `TypeError`
  - verify: integration

## Constraints

- No new third-party dependency in `package.json`; source map parsing uses Node core `node:module`.
- `src/agent` is not changed and gains no import; the feature lives in `src/analyzer`.
- The mapping never runs on the caller's event loop: it is a task on the analyzer worker pool, in a worker
  file under `src/analyzer/workers/`, never an inline or `eval`-based worker.
- No silent failures: a malformed map surfaces as a typed error on its frames, and pool or input failures
  reject the returned promise.
- Line and column numbers in and out are integers, 1-based, as printed in Node stack traces.
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build (including the
  bundled worker file) must keep compiling and loading.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for the integration criteria, with per-test
  results; the test stage's preflight decides whether that holds.
- Input frames name their file as a `file:` URL, as the description says; accepting plain absolute paths as
  well is left to the PLAN and not criterion-tested.
- A frame "carries" its original position as returned fields (for example the original source URL or path,
  line and column) next to or in place of the built ones; the exact field names, the function name and the
  error class name and `code` value are left to the PLAN, which must make them reachable from the analyzer
  entrypoint so the tests can be written against them.
- A file that cannot be read (missing or unreadable) is treated like a file with no source map: its frames
  are returned unchanged. Only a source map that is found but cannot be parsed is the typed error case.
- Fixture source maps are generated or hand-written as part of the tests; the "known original positions"
  are the ones those fixture maps record, so the expected values are fixed before the build.
- An unmapped `node:` or other non-`file:` frame needs no file read and is returned without error.
