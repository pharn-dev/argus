---
spec_id: collector-foreign-records
spec_content_hash: 2353b763b429ce0c87605f61c7ab705b18f5d411456d705a3fda9277b3cd25f9
applied_lessons: none
---

## Approach

ADVISORY model work. Two independent pieces in `src/collector`, then the docs and example that
describe them.

1. **Record guard in `consume()`.** A new object-mode Transform, first in `consume()`'s existing
   `pipeline()` (before the span router), classifies each record with a deterministic key-membership
   test and forwards only agent records:
   - **span**: `isSpanRecord(record)` (from `../agent/index.js`, unchanged: `type === 'span'`). No
     further span validation (SPEC non-goal).
   - **sample kind**: a non-null, non-array object whose `type` is `undefined` and that has all five
     keys `timestamp`, `eventLoop`, `memory`, `gc`, `backpressure` (`in` test). These are the fields
     the agent always writes and the fields `addSample` reads; `heapSpaces` and `dropped` are NOT
     required, because every existing collector, dashboard and otel test feeds samples without them.
     A pino line (`level`, `time`, `msg`) and `{ "foo": 1 }` therefore classify as **foreign**.
   - A sample-kind record is **valid** only when `timestamp` is a finite number, `eventLoop`,
     `memory`, `gc`, `backpressure` are non-null objects, and every numeric field `addSample` reads
     is `typeof 'number'` (`eventLoop.max/p99/mean`, `memory.heapUsed/rss`,
     `gc.count/totalPause/maxPause`, `backpressure.events/totalStall/maxStall`). Otherwise it is
     **malformed** (e.g. `timestamp: null`). This closes every path by which an agent-kind record
     could make `addSample` throw or write `NaN` into a window, so a bad record can never reject
     `consume()`.
   - Every other record is **foreign**.
   Skipped records increment a collector-wide integer counter (saturating add, never past
   `Number.MAX_SAFE_INTEGER`) exposed as `collector.ignored` (a getter on the returned object, next
   to `windows`, `alerts`, `spans`, `persistence`). The counter is incremented **before** the
   optional `onIgnored(record, reason)` hook runs (`reason: 'foreign' | 'malformed'`). A hook that
   throws errors the guard Transform with that error, so `consume()` rejects with it: explicit, never
   swallowed (SPEC constraint; the "how a hook that throws is surfaced" decision). `createCollector`
   throws `TypeError` when `onIgnored` is given and is not a function, matching the eager validation
   it already does. `consume()`'s parameter type widens from
   `Readable | AsyncIterable<AgentSample | SpanRecord>` to `Readable | AsyncIterable<unknown>`
   (backward compatible: the guard now owns the type check). The window aggregator keeps its own
   `timestamp` check unchanged as defense in depth.

2. **`createNdjsonDecoder(options?)`** in a new file: a `Transform` with byte input
   (`writableObjectMode: false`) and object output (`readableObjectMode: true`), returned with
   read-only integer counters `invalid` and `oversized`.
   - `maxLineBytes` (optional, default exported `DEFAULT_MAX_LINE_BYTES = 1_048_576`) must be a
     positive safe integer, else `RangeError` (same style as `windowMs`). `onSkipped` must be a
     function when given, else `TypeError`.
   - Bytes are split on `0x0A`. Splitting the raw bytes (not decoded text) is UTF-8-safe because
     `0x0A` never occurs inside a multi-byte sequence, so a chunk boundary in the middle of a line or
     of a character is harmless; each complete line is decoded once with `toString('utf8')`.
   - The partial line is held as a list of Buffer slices plus a byte length. When the held length
     would exceed `maxLineBytes`, the slices are dropped and the decoder enters a discard state until
     the next `0x0A` (or end of input); that line is then counted once as `oversized`. Held memory per
     partial line therefore never exceeds `maxLineBytes` (SPEC constraint). A line of exactly
     `maxLineBytes` bytes (newline excluded) is accepted.
   - A complete line whose text is whitespace only is skipped and **not** counted (blank line). Any
     other line goes through `JSON.parse` in a `try`; a parse failure, or a result that is not a
     non-null, non-array object (`42`, `"x"`, `null`, `[1]`), is counted as `invalid`. A trailing
     `\r` is JSON whitespace, so CRLF input parses unchanged.
   - Each skipped line (invalid or oversized) calls `onSkipped(skip)` once, after its counter is
     incremented, with `{ reason: 'invalid', line }` or `{ reason: 'oversized', bytes }` (`bytes`
     is the line's byte length, saturating). The full text of an oversized line is never retained.
     A hook that throws errors the decoder with that error (the transform/flush callback receives
     it), so a surrounding `pipeline()` rejects.
   - `flush` decodes a final line that has no trailing newline (or counts it as oversized when the
     decoder is in the discard state).
   - String chunks written by a caller are converted with `Buffer.from(chunk, encoding)`.

3. **Wiring without `.pipe()` — a documented `pipeline()` pattern, no new helper.** `consume()`
   already accepts an `AsyncIterable`, and `stream/promises` `pipeline()` accepts a final function
   stage that receives the previous stage as an async iterable. So the supported wiring is:

   ```js
   await pipeline(input, createNdjsonDecoder({ maxLineBytes }), (records) =>
     collector.consume(records),
   );
   ```

   A decoder error rejects `consume()` (it iterates the decoder) and the outer `pipeline()`; a
   `consume()` rejection rejects the outer `pipeline()`, which destroys `input` and the decoder. This
   is the shape the README, the example and AC-3 use.

4. **Docs, README, example, CHANGELOG** updated to that contract (Steps below). They have no AC of
   their own (SPEC assumption); format, lint and exports gates cover them.

## Applied lessons

- none: `check-lessons-index.mjs --verdict` returned `NO_CANON`; this project has no
  `memory-bank/lessons-learned.md` yet, so there are no promoted lessons to apply.

## Steps

- Add `src/collector/record-guard.ts`: export `type IgnoredReason = 'foreign' | 'malformed'`,
  `type IgnoredRecordHandler = (record: unknown, reason: IgnoredReason) => void`, a pure
  `classifyRecord(value: unknown): 'sample' | 'span' | IgnoredReason` implementing the tests in the
  Approach, and `createRecordGuard(onSkip: (record: unknown, reason: IgnoredReason) => void): Transform`
  (object mode; forwards `sample`/`span` chunks unchanged, calls `onSkip` for the rest; any throw from
  `onSkip` goes to `callback(error)`). No `any`.
- Edit `src/collector/collector.ts`: add `onIgnored?: IgnoredRecordHandler` to `CollectorOptions`
  with a TSDoc line stating that foreign and malformed records are skipped and counted, never thrown,
  and that a throwing hook rejects `consume()`; add `readonly ignored: number` to `Collector`; keep a
  closure counter, incremented with a saturating add before the hook; insert
  `createRecordGuard(...)` as the stage right after `source` in the existing `pipeline()`; widen
  `consume()`'s parameter to `Readable | AsyncIterable<unknown>`; validate `onIgnored` eagerly
  (`TypeError`). Remove the now-unused `AgentSample` import if the widening leaves it unused.
- Add `src/collector/ndjson-decoder.ts`: export `DEFAULT_MAX_LINE_BYTES`, `type NdjsonSkip`
  (`{ reason: 'invalid'; line: string } | { reason: 'oversized'; bytes: number }`),
  `type NdjsonDecoderOptions = { maxLineBytes?: number; onSkipped?: (skip: NdjsonSkip) => void }`,
  `type NdjsonDecoder = Transform & { readonly invalid: number; readonly oversized: number }`, and
  `createNdjsonDecoder(options?: NdjsonDecoderOptions): NdjsonDecoder` as described in the Approach
  (counters exposed with `Object.defineProperties` getters on the Transform instance; integer
  saturating adds; explicit `try/catch` around `JSON.parse` and around the hook, errors passed to the
  callback).
- Edit `src/collector/index.ts`: export `createNdjsonDecoder`, `DEFAULT_MAX_LINE_BYTES` and the types
  `NdjsonDecoder`, `NdjsonDecoderOptions`, `NdjsonSkip` from `./ndjson-decoder.js`, and the types
  `IgnoredReason`, `IgnoredRecordHandler` from `./record-guard.js`. `classifyRecord` and
  `createRecordGuard` stay internal.
- Edit `README.md` "Add the live dashboard": drop "assuming your app writes nothing else to stdout",
  replace the `readline` + `JSON.parse` generator with the decoder and the `pipeline()` pattern from
  the Approach, and add one or two sentences: non-agent stdout lines (plain text, JSON logger lines)
  are skipped and counted (`decoder.invalid` / `decoder.oversized`, `collector.ignored`, optional
  `onSkipped` / `onIgnored` hooks); malformed agent records are skipped and counted, not thrown.
- Edit `examples/express-app/index.mjs`: delete `parseLine`, `decodeNdjson` and the hand-rolled
  `MAX_LINE_LENGTH` logic; import `createNdjsonDecoder` from `@pharn-dev/phargus/collector` and
  `pipeline` (already imported); build `consumed` as
  `settle(pipeline(child.stdout, createNdjsonDecoder({ maxLineBytes: MAX_LINE_BYTES }), (records) => collector.consume(records)))`
  with `MAX_LINE_BYTES = 1024 * 1024`; at shutdown, write one stderr line with the decoder's
  `invalid`/`oversized` counts and `collector.ignored` when any is non-zero. Keep every existing
  error path.
- Edit `examples/express-app/app.mjs`: replace the "nothing else here may write to stdout" comment
  with one saying the app may log to stdout and the parent's decoder and collector skip those lines;
  add one `console.log` plain-text line when the server starts listening, so the example exercises
  the mixed-stdout path.
- Edit `examples/express-app/README.md`: one sentence that the app logs to its own stdout too and the
  parent skips and counts every line that is not agent data.
- Edit `ARCHITECTURE.md` data flow step 3: `consume()` takes any parsed records; a record guard
  forwards sample and span records and skips and counts the rest (`ignored`, `onIgnored`, foreign vs
  malformed); `createNdjsonDecoder` turns the byte stream into objects with bounded line memory,
  skipping and counting non-object and over-long lines; the `pipeline()` wiring pattern.
- Edit `FEATURES.md` section 4: one bullet for the decoder and the record guard (tolerates app output
  on the shared stdout; skipped lines/records counted). Adjust the section 1 "default output is the
  app's stdout" bullet only if its wording now overstates a limitation.
- Edit `docs/LIMITS.md` "The default output shares your stdout": the collector now tolerates app
  output; remaining limits stated plainly: an app line that happens to have the agent's sample keys
  (or `type: "span"`) is taken as agent data, a malformed agent record is dropped (counted, not
  aggregated), and lines past `maxLineBytes` are dropped.
- Edit `docs/THREAT-MODEL.md`: a new table row (next free id in the collector/data area, e.g. `A3`
  or an `H1` "Collector input" row, chosen to match the table's lettering) for parsing the untrusted,
  app-shared stdout: threat = a line from the app (or anyone who can write to that stdout) crashes
  the collector, exhausts memory, or is read as agent data; mitigation = bounded per-line memory
  (`maxLineBytes`), parse failures and non-agent records skipped and counted, never thrown, hook
  errors surfaced; named tests = the three new AC test files; residual = a forged record with the
  agent's shape is aggregated as agent data (no authentication of the channel); status "Partly
  enforced".
- Edit `CHANGELOG.md`: under `## [Unreleased]`, add `### Fixed` (it does not exist yet) with an entry
  for F1: the collector no longer dies on non-agent stdout lines; foreign and malformed records are
  skipped and counted (`collector.ignored`, `onIgnored`), including the decision that malformed agent
  records are skipped rather than thrown; new `createNdjsonDecoder` export. Keep the version unchanged.
- Run `npx prettier --write` on each touched file by name, then `npm run typecheck`, `npm run lint`,
  `npm test`, `npm run build`, `npm run check:exports`, `npm run format:check`.

## Files

- `src/collector/record-guard.ts` — new: record classification (sample / span / foreign / malformed) and the guard Transform
- `src/collector/ndjson-decoder.ts` — new: `createNdjsonDecoder`, `DEFAULT_MAX_LINE_BYTES` and its types
- `src/collector/collector.ts` — `onIgnored` option, `ignored` read-out, guard stage in `consume()`, widened `consume()` input type
- `src/collector/index.ts` — export the decoder, its constant and types, and the ignored-record types
- `README.md` — collector snippet switched to the decoder and the `pipeline()` pattern; stdout caveat removed
- `examples/express-app/index.mjs` — hand-rolled decoder replaced by `createNdjsonDecoder` + `pipeline()`
- `examples/express-app/app.mjs` — stdout workaround comment removed; one plain-text stdout log line
- `examples/express-app/README.md` — note that app stdout logging is tolerated
- `ARCHITECTURE.md` — data flow step 3 describes the guard, the decoder and the wiring
- `FEATURES.md` — data pipeline section lists the decoder and record guard
- `docs/LIMITS.md` — shared-stdout limit rewritten to the new behavior and its residual limits
- `docs/THREAT-MODEL.md` — new row for parsing the untrusted, app-shared stdout
- `CHANGELOG.md` — `## [Unreleased]` → `### Fixed` entry for F1

### Explicitly not touched

- `src/agent/` — no change to agent code, imports or output (SPEC non-goal and constraint)
- `src/collector/window-aggregator.ts` — keeps its timestamp check as defense in depth; reused
- `src/collector/span-router.ts` — reused unchanged after the guard
- `package.json` — no version bump, no new export subpath (the decoder ships through `./collector`)
- `package-lock.json` — unchanged
- `scripts/install-smoke.mjs` — keeps its own decoding; out of scope
- `bench/lib/soak-collector.mjs` — out of scope
- `vitest.config.mts` — test infrastructure, pinned by the test stage
- `src/dashboard/` — showing the counts in the UI is a SPEC non-goal

## Acceptance mapping

- AC-1 → `createNdjsonDecoder({ maxLineBytes: 1024, onSkipped })` splits raw bytes on `0x0A` across
  chunk boundaries, skips the blank line uncounted, counts the plain text, truncated JSON and `42`
  as `invalid` (3), the line of at least 2048 bytes as `oversized` (1) while the ~365-byte agent
  sample line fits under the limit, calls the hook 4 times, decodes the
  final unterminated line in `flush`, and emits the pino object, sample, span and final object in
  order.
- AC-2 → the record guard in `consume()` forwards the three samples (windows 1000 with count 2 and
  2000 with count 1) and the span (to `spans`), skips the pino object and `{ foo: 1 }` as `foreign`
  and the `timestamp: null` sample-shaped record as `malformed`; `collector.ignored === 3`; the hook
  is called 3 times, `malformed` only for the sample-shaped record; `consume()` resolves.
- AC-3 → `pipeline(bytes, createNdjsonDecoder({ maxLineBytes }), (records) => collector.consume(records))`
  resolves; text and truncated lines are decoder `invalid`, the long line decoder `oversized` (1),
  pino lines reach the guard and are `foreign` (so `collector.ignored` equals the pino line count),
  and windows and spans equal a clean run of the same samples and spans.

## Risks & open questions

- **Shape-based recognition is advisory, not authentication.** An app line carrying the five sample
  keys, or `"type":"span"`, is taken as agent data. Stated in `docs/LIMITS.md` and the threat-model
  row as a residual; a framing or channel change is a SPEC non-goal.
- **AC-2's "sample-shaped" record**: the plan defines sample kind as having all five keys
  `timestamp`, `eventLoop`, `memory`, `gc`, `backpressure` with `type` absent. `/pharn-test` must
  build the malformed record with those five keys (only `timestamp: null`), or it will classify as
  foreign. Recorded in the AC-2 mapping target.
- **Widening `consume()`'s input type** to `AsyncIterable<unknown>` is source compatible for callers;
  `src/dashboard/server.ts` takes a `Collector` and only gains a field it does not read.
- **Decoder hook payload**: an oversized line reports `bytes`, never its text, to keep memory bounded;
  the AC asks only for the call count.
- **CRLF and a UTF-8 BOM**: CRLF parses (trailing `\r` is JSON whitespace). A leading BOM on the
  first line makes that line `invalid`; the agent never writes one, so it is accepted as is.
