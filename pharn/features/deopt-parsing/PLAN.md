---
spec_id: deopt-parsing
spec_content_hash: 5d64f0d2e6004d0dd168f8a42c0369b49dfee8f8851b21033b93ac3b47c6c822
applied_lessons: none
---

## Approach

> ADVISORY: model work, derived from the Approved SPEC `deopt-parsing` (`spec_kind: quick`, ROADMAP S5 item
> "`--trace-deopt` parsing").

Discovery (live, this run): the agent is `src/agent/` of a single npm package. `src/agent/index.ts` is the
side-effect-free library entry; `src/agent/auto.ts` does `export * from './index.js'` and then starts the agent,
so anything exported from `index.ts` is reachable from `argus/agent`. Earlier features' AC tests import from
`./index.js` (not `auto.ts`) to avoid starting the agent; this feature's tests do the same. ESLint
(`eslint.config.mjs`) restricts `src/agent/**/*.ts` (not tests) to `node:` builtins and own files. tsc
(`tsconfig.esm.json`, `tsconfig.cjs.json`) compiles only `src/**/*.ts` minus tests, so `.txt` fixtures under `src/`
are neither compiled nor published (`package.json` `files: ["dist"]`); vitest includes `src/**/*.test.ts`.
Prettier does not format `.txt` files. No fixtures directory exists in the repo yet.

The six supplied fixtures were found this run in the session scratchpad at
`/private/tmp/claude-501/-Users-pgalarowicz-Projects-argus/4b58b501-05f5-44d5-ba77-396f9a06ffe5/scratchpad/deopt/samples/`.
That `samples/` set is the path-sanitized one (script paths read `/app/deopt.js`, `/app/lazy.js`); the sibling
files one level up are the unsanitized captures and are **not** used. Counts measured this run on `samples/`
match the SPEC's criteria (node22.txt 6 headlines, node24.txt 5, node22-verbose.txt 7, node24-verbose.txt 7,
lazy22-verbose.txt 1 headline + 1 marking line, lazy24-verbose.txt 2 headlines + 4 marking lines; no `\r`).

### Design

One new pure module, `src/agent/deopt-parser.ts`, Node core only (in fact no imports at all):

- `export const ANONYMOUS_FUNCTION = '(anonymous)';` — the fixed marker used when V8 prints
  `<JSFunction (sfi = …)>` or `<SharedFunctionInfo>` with no name.
- `export type DeoptLocation = { scriptUrl: string; line: number; column: number };`
- `export type DeoptEvent = { kind: string; reason: string; functionName: string; tier: string; location: DeoptLocation | null };`
  - bailout events: `kind` is V8's kind with the `deopt-` prefix stripped (`deopt-eager` → `eager`; `lazy`, `soft`
    by the same rule; a kind without the prefix is kept as printed); `tier` is the `<Code TIER>` token
    (`TURBOFAN`, `MAGLEV`, `TURBOFAN_JS`, …); `location` is `null` until a position line attaches one.
  - marking-dependent-code events: `kind` is the constant `'dependent-code'` (exported as
    `DEPENDENT_CODE_KIND`), `functionName` from `<SharedFunctionInfo NAME>`, `tier` from the line's `<Code TIER>`,
    `reason` from `reason: …]`, `location` always `null`.
- `export type DeoptParser = { push(line: string): void; events(): DeoptEvent[]; counts(): Map<string, number>; unparseableLines(): number };`
- `export function createDeoptParser(): DeoptParser` — each call returns a parser with its own closure state
  (events array, counts map, unparseable counter, pending-headline reference). No module-level mutable state,
  no I/O, no timers. Events are read on demand (`events()` returns a shallow copy of the array; each event is a
  fresh object with its `location` copied, so callers cannot mutate parser state); `counts()` returns a new `Map`.

`push(line)` rules (applied to `line` with one trailing `\r` removed, then `trimStart()`; a non-string argument
is treated as an empty line, never thrown on):

1. Empty after trimming → ignored, not counted.
2. Starts with `[bailout (` → match the headline regex, roughly
   `^\[bailout \(kind: ([^,)]+), reason: (.+?)\): begin\. deoptimizing .*?<JSFunction(?: (.+?))? \(sfi = [^)]*\)>, .*?<Code ([A-Za-z0-9_]+)>`.
   Match → push a bailout event, increment `counts` for its function name by integer `+ 1`, and set it as the
   pending headline. No match → `unparseable += 1` and clear the pending headline.
3. Starts with `;;; deoptimize at ` → if there is a pending headline and the first `<…>` group matches
   `^<(.+):(\d+):(\d+)>` (greedy url, so a url containing `:` keeps it), with both numbers parsing to safe
   integers, attach `{ scriptUrl, line, column }` to the pending event and clear the pending headline. The
   first `<…>` after `deoptimize at` is the innermost position, so a trailing `inlined at <…>` is ignored.
   No pending headline, or no match → `unparseable += 1`.
4. Starts with `[marking dependent code` → match roughly
   `^\[marking dependent code .*?<Code ([A-Za-z0-9_]+)> \(.*?<SharedFunctionInfo(?: (.+?))?>\).* for deoptimization, reason: (.+)\]$`.
   Match → push a dependent-code event (does **not** touch `counts`; see Risks). No match → `unparseable += 1`.
   Either way, clear the pending headline.
5. Starts with `[bailout end.` → clear the pending headline; not counted.
6. Anything else (frame dumps, `reading input frame …`, program output) → ignored, not counted, pending
   headline unchanged (in the captures the position line directly follows its headline; keeping the pending
   headline across ignored lines is harmless and tolerates interleaved program output).

Counts are integers by construction (`(map.get(name) ?? 0) + 1`). Line/column come from
`Number.parseInt(…, 10)` checked with `Number.isSafeInteger`.

## Applied lessons

- none — `check-lessons-index.mjs --verdict` returned `NO_CANON` this run: the project has no
  `memory-bank/lessons-learned.md` yet, so there are no lessons to apply.

## Steps

- Copy the six fixtures **byte-for-byte** from the scratchpad `samples/` directory named in Approach into
  `src/agent/__fixtures__/deopt/` (same file names). Do not reformat, trim or re-wrap them; their SHA-256
  values (measured this run) are:
  - `node22.txt` `b7907407ed4ff66e3175644da4aa2994863689fa6f4ab3731aa6cb0d6fb2948d`
  - `node24.txt` `c8163b7f063044f9f04b21b8e8efe971e62eece12a70430ec90a30d495542744`
  - `node22-verbose.txt` `8682f0ec744a3106e4e58901ef3bc68d2ed9174797e9c8ff13d26dd329f4fca7`
  - `node24-verbose.txt` `c8db90811a038b47cfe4ed6fcc9a2447b072c5349908f8726ec907f5622e9ebd`
  - `lazy22-verbose.txt` `001f5dc088ce3f59ed9e904effbe1571a662daf336a31f2f6d011ac0e31f9b1f`
  - `lazy24-verbose.txt` `d962fd76e1057c7feccc36c32cb199321e2ba94f899cc29865bf92abba71392f`
- Write `src/agent/deopt-parser.ts` per the Design above, with a short header comment naming the two V8 line
  shapes it reads (Node 22 / V8 12.4 and Node 24) and the "unparseable is counted, never thrown" rule.
- Re-export from `src/agent/index.ts`: `createDeoptParser`, `ANONYMOUS_FUNCTION`, `DEPENDENT_CODE_KIND`, and the
  types `DeoptEvent`, `DeoptLocation`, `DeoptParser`.
- Run `npx prettier --write` on each `.ts` file written, then `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run build`, `npm run check:exports`.

## Files

- `src/agent/deopt-parser.ts` — new: `createDeoptParser()`, `ANONYMOUS_FUNCTION`, `DEPENDENT_CODE_KIND`, `DeoptEvent`, `DeoptLocation`, `DeoptParser`; pure line consumer for `--trace-deopt` / `--trace-deopt-verbose` output
- `src/agent/index.ts` — modified: re-exports the deopt parser's values and types
- `src/agent/__fixtures__/deopt/node22.txt` — new: byte copy of the supplied Node 22 plain `--trace-deopt` capture
- `src/agent/__fixtures__/deopt/node24.txt` — new: byte copy of the supplied Node 24 plain `--trace-deopt` capture
- `src/agent/__fixtures__/deopt/node22-verbose.txt` — new: byte copy of the supplied Node 22 `--trace-deopt-verbose` capture
- `src/agent/__fixtures__/deopt/node24-verbose.txt` — new: byte copy of the supplied Node 24 `--trace-deopt-verbose` capture
- `src/agent/__fixtures__/deopt/lazy22-verbose.txt` — new: byte copy of the supplied Node 22 lazy-deopt verbose capture
- `src/agent/__fixtures__/deopt/lazy24-verbose.txt` — new: byte copy of the supplied Node 24 lazy-deopt verbose capture

### Explicitly not touched

- `src/agent/auto.ts`, `src/agent/auto-start.ts` — `auto.ts` already re-exports everything from `index.ts`.
- `src/agent/sampler-controller.ts`, `src/agent/ndjson-exporter.ts`, `src/collector/**`, `src/dashboard/**` — wiring the parser in is a SPEC non-goal.
- `src/agent/context.ts` — no `async_hooks` use in this feature.
- `package.json`, `vitest.config.mts`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`, `eslint.config.mjs`, `scripts/build.mjs` — test and build infrastructure, out of scope.
- `CHANGELOG.md`, `FEATURES.md`, `ROADMAP.md` — not changed by this slice (matches earlier agent slices).

## Acceptance mapping

- **AC-1** (plain fixtures, Node 22: 6 events, Node 24: 5, kind `eager`, reasons, names, no location, counts) →
  rule 2 parses every headline; `kind` strips `deopt-`; names come from `<JSFunction NAME (sfi …)>` or
  `ANONYMOUS_FUNCTION`; `location` stays `null` because the plain fixtures have no position lines; `counts()`
  increments by 1 per headline. Test: `src/agent/deopt-parsing.ac1.test.ts` (see AC-TESTS.md).
- **AC-2** (verbose fixtures: event count = headline count; `add` at `/app/deopt.js:1:31`; `lazy.js` 6:18 with
  `inlined at`; marking events `hot` / `outer` with non-`eager` kind) → rule 2 only matches lines that **start**
  with `[bailout (` after trimming, so frame-dump lines naming `require` never match; rule 3 attaches the first
  `<url:line:col>`; rule 4 yields `kind: 'dependent-code'` events with the SharedFunctionInfo name (anonymous
  ones get `ANONYMOUS_FUNCTION`). Test: `src/agent/deopt-parsing.ac2.test.ts`.
- **AC-3** (truncated headline, orphan position line, malformed marking line, empty string, then a valid
  headline: no throw, unparseable = 3, one event with count 1) → rules 2/3/4 count non-matching lines, rule 1
  ignores the empty string, the truncated headline clears the pending reference so the orphan position line
  is counted, and the valid headline is then parsed normally. Test: `src/agent/deopt-parsing.ac3.test.ts`.

## Risks & open questions

- **Fixtures land with the build, not with the tests.** The AC-TESTS mapping may list only mapped test files,
  so the fixtures are in this PLAN's `## Files` and the build writes them. Before the build the AC tests fail
  on a missing fixture (a weaker red than a failing assertion), and the build could in principle edit a fixture
  to fit its parser. Mitigation for `/pharn-test`: each AC test should first assert the SHA-256 of every
  fixture it reads against the values listed under Steps (via `node:crypto`), so a build that alters or
  re-wraps a fixture turns the pinned test red.
- **Fixture source lives in the session scratchpad.** The build agent must read it from the path in Approach;
  if that directory is gone, the build cannot reproduce the fixtures and must halt rather than reconstruct them.
- **Counts exclude dependent-code events.** `counts()` aggregates bailout headlines only, which is what AC-1's
  "number of headlines naming that function" literally says; dependent-code events are still returned by
  `events()`. Counting them too would double-count a function that is both marked and bailed out. Flagged for
  `/pharn-grill`.
- **Unbounded memory.** `events()` grows with every headline for the life of the parser. Fine for a captured log
  or a bounded child process; a ring buffer belongs to the later wiring slice (SPEC non-goal here).
- **Regex brittleness across V8 versions.** The regexes are tuned to the two captured shapes; a future V8 that
  changes the headline shape makes those lines unparseable (counted), not a crash — by design.
- **Name choices** (`createDeoptParser`, `ANONYMOUS_FUNCTION = '(anonymous)'`, `DEPENDENT_CODE_KIND =
'dependent-code'`, `counts()` returning a `Map`) are this plan's choice where the SPEC left them open.
