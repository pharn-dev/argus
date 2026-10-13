---
spec_id: collector-foreign-records
state: Approved
spec_content_hash: 2353b763b429ce0c87605f61c7ab705b18f5d411456d705a3fda9277b3cd25f9
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Review finding F1 (High). The agent writes its NDJSON to the monitored app's stdout by default, and
real apps write to stdout too: plain `console.log` text and JSON loggers such as pino
(`{"level":30,"time":1700000000000,"msg":"hi"}`). Today one such line breaks monitoring. The README
collector snippet `JSON.parse`s every stdout line, so a plain-text line throws; a JSON line that is not
an agent record reaches the window aggregator, which rejects `collector.consume()` with
`TypeError: sample.timestamp must be a finite number`. The collector stops reading, the agent's next
write fails with EPIPE, and the agent disables itself. The express-app example works around this by
forbidding the app from writing to stdout. Users who reach for Phargus at 2am will have apps that log
to stdout; the collector must tolerate that, skipping and counting what is not agent data instead of
dying, and Phargus must ship a decoder so nobody hand-rolls the fragile line parsing.

## Scope

**In scope:**

- A record guard at the start of the collector's `consume()` path that recognizes every record kind the
  agent emits on its NDJSON stream (today: sample lines, which carry no `type`, and span lines, which
  carry `type: 'span'`) and skips every other record instead of rejecting `consume()`.
- An integer `ignored` count of skipped records, exposed on the collector next to its existing
  read-outs, plus an optional `onIgnored` hook option called once per skipped record with the record
  and the reason it was skipped (foreign, or malformed agent record).
- Agent-kind records with bad fields (for example a sample line whose `timestamp` is not a finite
  number) are skipped and counted with the malformed reason, not thrown, because rejecting `consume()`
  is exactly the failure that tears down the pipeline and disables the agent through EPIPE. This
  decision is documented in the collector docs and the CHANGELOG.
- `createNdjsonDecoder({ maxLineBytes })` exported from `@pharn-dev/phargus/collector`: a Transform
  that takes bytes and emits parsed JSON objects in object mode, one per line. Lines that do not parse
  to a JSON object (plain text, truncated JSON, a bare JSON value) and lines longer than
  `maxLineBytes` are skipped and counted in integer counters read from the decoder, with an optional
  hook called once per skipped line. Blank lines are skipped without being counted. A final line with
  no trailing newline is decoded when the input ends.
- The README collector snippet and `examples/express-app` switched to the decoder, and the example's
  "nothing else may write to stdout" workaround removed (the example app may log to stdout).
- Docs that describe the collector input contract updated where they are now wrong: `ARCHITECTURE.md`
  (data flow step 3), `FEATURES.md`, `docs/LIMITS.md`, `docs/THREAT-MODEL.md` (a row for parsing the
  untrusted, app-shared stdout), and an entry under `## [Unreleased]` -> `### Fixed` in `CHANGELOG.md`
  (the subsection created if absent).
- Vitest tests for the decoder, the guard, and the two wired together over mixed stdout.

**Out of scope (non-goals):**

- Bumping the package version or cutting a release.
- Any change to `src/agent` dependencies or imports, or to what the agent writes.
- Separating agent output from app output (a dedicated channel, a prefix or a framing change).
- Showing the `ignored` or decoder counts in the dashboard UI.
- Validating span fields beyond what recognizes a span record today, unless the plan needs it to
  classify a span as malformed.

## Acceptance Criteria

- **AC-1** Given a decoder created by `createNdjsonDecoder({ maxLineBytes: 1024 })` from the collector
  entrypoint with a skip hook When it is written, across chunk boundaries that split lines in the
  middle, a plain-text line, a pino-style JSON line, an agent sample line, a blank line, a truncated
  JSON line, a line of at least 2048 bytes, a span line, the JSON line `42`, and a final JSON object line
  with no trailing newline, and then ended Then it finishes without an error and emits exactly the
  pino-style object, the sample, the span and the final object, in that order; its counters report 3
  lines that are not a JSON object (the plain text, the truncated line and `42`) and 1 over-long line,
  and the hook was called 4 times
  - verify: unit
- **AC-2** Given a collector created from the collector entrypoint with `windowMs` 1000 and an
  `onIgnored` hook When it consumes an object source holding agent sample lines at timestamps 1000,
  1500 and 2500, one span record, a pino-style object, an object `{ "foo": 1 }`, and a sample-shaped
  record whose `timestamp` is `null` Then `consume()` resolves; the windows read back are start 1000
  with sample count 2 and start 2000 with sample count 1; the spans read back are exactly the one span;
  the collector's `ignored` count is 3; and the hook was called 3 times, with the malformed reason only
  for the sample-shaped record
  - verify: unit
- **AC-3** Given a collector and a decoder created from the collector entrypoint, wired with
  `stream/promises` `pipeline()` and no `.pipe()` When a byte stream of mixed stdout is run through
  them: `console.log` text lines, pino-style JSON lines, a truncated JSON line, a line longer than
  `maxLineBytes`, and agent sample and span lines encoded the way the agent writes them Then
  `consume()` resolves and never rejects; the windows read back equal the windows the same samples
  produce with no foreign lines; the spans read back are exactly the encoded spans; the collector's
  `ignored` count equals the number of pino-style lines; and the decoder's counters equal the number of
  text plus truncated lines and 1 over-long line
  - verify: integration

## Constraints

- `src/agent` keeps zero third-party dependencies and gains no new imports; `src/collector` uses Node
  core only.
- `createNdjsonDecoder` and its types load through both `import` and `require` of
  `@pharn-dev/phargus/collector` (`npm run check:exports` passes after `npm run build`), with types for
  both conditions.
- Stream wiring uses `stream/promises` `pipeline()`, never `.pipe()`, in source, README and example.
- No silent failure: every skipped record or line is counted, and the hook (when given) sees it; a hook
  that throws is surfaced explicitly, never swallowed.
- Counters are integers. The decoder's memory per partial line is bounded by `maxLineBytes`.
- TypeScript strict mode; prettier on every touched file; npm only; the package version is not bumped.

## Assumptions

- Recognizing a sample line is a deterministic shape test over fields the agent always writes; the plan
  picks the exact fields, so that a pino-style line is foreign and a record with the agent's sample
  fields but a bad `timestamp` is malformed.
- Malformed agent records are skipped and counted rather than thrown (decision delegated by the
  increment description: throwing kills the pipeline); they share the `ignored` count and differ only by
  the reason passed to `onIgnored`.
- The decoder emits only JSON objects: `null` cannot travel through an object-mode stream, and a bare
  JSON value is never an agent record, so such lines are counted with the unparsable lines.
- How a hook that throws is surfaced (rejecting `consume()`, or erroring the decoder) is a plan
  decision, bounded by the no-silent-failure constraint.
- The README, example, docs and CHANGELOG edits have no acceptance criterion of their own; they are
  checked by review and by the format, lint and exports gates.
- The project has a findable test runner (`npm test` runs `vitest run`); the test stage's preflight
  confirms it.
- Wiring the decoder into `consume()` without `.pipe()` may need an exported helper or a documented
  `pipeline()` pattern; which one is a plan decision.
