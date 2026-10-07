---
spec_id: plugin-runner-rule-library
spec_content_hash: 2a6a43fac113477b6067e76af3f3c22eba584fdbf43ceb203ffb14945a660e35
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `plugin-runner-rule-library` (ROADMAP S6, slice 2).

Discovery (live, this run): `src/plugin-runner/` already holds the sandbox slice: `plugin-runner.ts`
(`createPluginRunner(options?)` → `{ run(source, windows): Promise<RuleRunResult>; close() }`, `run` never rejects
and runs one rule at a time through a serial queue), `rule-result.ts` (`RuleErrorCode` frozen object with
`ARGUS_RULE_THREW`, `ARGUS_RULE_TIMEOUT`, `ARGUS_RULE_MEMORY_LIMIT`, `ARGUS_RULE_COMPILE_ERROR`,
`ARGUS_ISOLATED_VM_MISSING`, `ARGUS_RULE_INVALID_RESULT`, `ARGUS_SANDBOX_CRASHED`, `ARGUS_RUNNER_CLOSED`;
`RuleFinding = { windowStart, message }`; `RuleRunResult`), the IPC child under `workers/`, and `index.ts`
exporting those plus the scaffold `PluginRunnerPlaceholder`. A rule source is a function body receiving `windows`
(the sandbox child wraps it as `(function (windows) { <source> })`), so a parse error surfaces as
`ARGUS_RULE_COMPILE_ERROR` and a throw as `ARGUS_RULE_THREW`. `AggregatedWindow` (`src/collector/window.ts`):
`start`/`end` are millisecond timestamps (`end = start + windowMs`), `eventLoop.max` is nanoseconds,
`memory.heapUsedLast` bytes, `gc.totalPause` nanoseconds (`src/agent/gc-sampler.ts` accumulates `pauseNs`). All
integers. `isolated-vm` 6.x is already a devDependency and an optional peer dependency; no `package.json` change is
needed. `tsconfig.base.json` is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

Design (each file one axis of change; new host code imports Node core and the plugin-runner's own files, plus
`import type` from `../collector/index.js`; the sandbox child, `src/agent` and `src/collector` are unchanged):

1. **Error codes** (`src/plugin-runner/rule-result.ts`, modified) — add to `RuleErrorCode`:
   - `INVALID_PARAMETER: 'ARGUS_RULE_INVALID_PARAMETER'` — a built-in rule was configured with a bad parameter.
   - `RULES_DIR_UNREADABLE: 'ARGUS_RULES_DIR_UNREADABLE'` — the rules directory does not exist or cannot be listed.
   - `RULE_FILE_UNREADABLE: 'ARGUS_RULE_FILE_UNREADABLE'` — one `.js` rule file could not be read.
   - `DUPLICATE_RULE_ID: 'ARGUS_RULE_DUPLICATE_ID'` — the run-all helper got two rules with the same id.
     Nothing else in the file changes; `RuleErrorCodeValue` widens automatically. The sandbox child keeps its own
     string literals and is not touched.
2. **Rule descriptor** (`src/plugin-runner/rule-descriptor.ts`, new) — the type every rule shares:
   `RuleDescriptor = { readonly id: string; readonly source: string }`. Types only.
3. **Parameter error** (`src/plugin-runner/rule-parameter-error.ts`, new) —
   `class RuleParameterError extends Error` with `readonly code = RuleErrorCode.INVALID_PARAMETER`,
   `readonly ruleId: string`, `readonly parameter: string`, `name = 'RuleParameterError'`, and a message
   `built-in rule "<ruleId>": parameter "<parameter>" <problem>, got <describe(value)>`. Plus two small checkers
   used by the built-in factories, each throwing that error: `readIntegerParam(ruleId, params, name, default, min,
   max?)` (absent → default; present → must be `typeof 'number'`, `Number.isSafeInteger`, `>= min`, `<= max` when
   given) and `assertParamsObject(ruleId, params, allowedNames)` (`undefined` → `{}`; anything not a plain
   non-array object → error naming parameter `params`; any own key outside `allowedNames` → error naming that key,
   so a misspelt parameter is never silently ignored).
4. **Built-in rules** (`src/plugin-runner/builtin-rules.ts`, new) — the rule library.
   - `BuiltinRuleId = Object.freeze({ EVENT_LOOP_LAG: 'argus/event-loop-lag', HEAP_GROWTH: 'argus/heap-growth',
GC_PAUSE_SHARE: 'argus/gc-pause-share' } as const)`. The `argus/` prefix cannot come from a file name, so a
     user rule can never take a built-in id.
   - Three factories, each validates **synchronously, before returning** (so an invalid configuration throws
     `RuleParameterError` and no descriptor, hence no sandbox run, ever exists), then returns a frozen
     `RuleDescriptor` whose `source` is `const params = <JSON.stringify(validatedParams)>;\n` followed by the
     fixed rule body. The params are validated integers, so the JSON literal is inert data.
     - `eventLoopLagRule(params?: { thresholdNs?: number; windows?: number })` — defaults `thresholdNs`
       100_000_000 (100 ms), `windows` 3. `thresholdNs` a safe integer ≥ 0; `windows` a safe integer ≥ 1. Body:
       walk `windows` in list order, tracking maximal runs of adjacent windows with `w.eventLoop.max >
params.thresholdNs`; for every run of length ≥ `params.windows`, push one finding per window in the run
       (`{ windowStart: w.start, message: 'event-loop max <max> ns above <threshold> ns for <len> consecutive
windows' }`).
     - `heapGrowthRule(params?: { windows?: number })` — default `windows` 3; a safe integer ≥ 2 (one window
       cannot rise). Body: maximal runs of adjacent windows where each `memory.heapUsedLast` is strictly greater
       than the previous window's; for each run of length ≥ `params.windows`, one finding per window in the run,
       the run's first (baseline) window included, message naming the bytes at run start and at that window.
     - `gcPauseShareRule(params?: { thresholdPerMille?: number })` — default 100 (10 %); a safe integer in
       `0..1000`. Body, integer math only: for each window with `d = w.end - w.start > 0`, the window is a finding
       when `w.gc.totalPause > params.thresholdPerMille * d * 1000` (pause ns vs. threshold per-mille of `d` ms
       expressed in ns — equivalent to `perMille = floor(totalPause / (d * 1000)) `, compared without a float);
       message carries `Math.floor(w.gc.totalPause / (d * 1000))` per-mille. Windows with `d <= 0` are skipped.
   - Each body returns the findings array; it reads only `windows` and `params`.
5. **Rules directory** (`src/plugin-runner/rules-directory.ts`, new) — `loadRulesDirectory(dir: string):
Promise<RulesDirectoryResult>`, never rejects.
   - `readdir(dir, { withFileTypes: true })` from `node:fs/promises`; a throw (missing, not a directory, no
     permission) → `{ ok: false, error: { code: RuleErrorCode.RULES_DIR_UNREADABLE, message } }` naming the path
     and the cause.
   - Keeps entries with `entry.isFile()` and a name ending in `.js` (case-sensitive, as the SPEC says `.js`),
     sorted by name for a deterministic order. Every other entry is ignored.
   - Each kept file is read **once** with `readFile(path, 'utf8')`; its id is the file name without `.js`. Success
     → a `RuleDescriptor { id, source }` in `rules`; a read failure → `{ id, error: { code:
RuleErrorCode.RULE_FILE_UNREADABLE, message } }` in `failures`. Result `{ ok: true; rules:
RuleDescriptor[]; failures: RuleLoadFailure[] }`.
   - The host never `require`s, `import`s or `eval`s a rule file: the text is handed to the sandbox only, and a
     file whose text is invalid JavaScript or throws still loads (its error appears when it runs).
6. **Run-all helper** (`src/plugin-runner/run-rules.ts`, new) — `runRules(runner: PluginRunner, rules: readonly
RuleDescriptor[], windows: readonly AggregatedWindow[]): Promise<Record<string, RuleRunResult>>`, never
   rejects.
   - First pass counts ids; any id seen more than once gets one `ruleFailure(RuleErrorCode.DUPLICATE_RULE_ID, …)`
     slot and none of its copies runs (explicit, never last-one-wins). A descriptor that is not an object with a
     string `id` cannot be keyed; it is skipped with a `process.emitWarning` naming its index (never silent).
   - Remaining rules run **sequentially** through the caller's `runner.run(rule.source, windows)`, each `await`
     wrapped in `try/catch` that turns an unexpected throw into `ruleFailure(RuleErrorCode.SANDBOX_CRASHED, …)`
     for that id only. The result object is built with `Object.fromEntries` (own data properties, so an id such as
     `__proto__` is still a plain key), in input order. The caller supplies and closes the runner.
7. **Entrypoint** (`src/plugin-runner/index.ts`, modified) — add exports: `BuiltinRuleId`, `eventLoopLagRule`,
   `heapGrowthRule`, `gcPauseShareRule`, `RuleParameterError`, `loadRulesDirectory`, `runRules`, and the types
   `RuleDescriptor`, `RulesDirectoryResult`, `RuleLoadFailure`, `RuleResults` (`Record<string, RuleRunResult>`),
   and the three params types `EventLoopLagParams`, `HeapGrowthParams`, `GcPauseShareParams`. Existing exports and
   `PluginRunnerPlaceholder` stay.

Constraints held by construction: `src/agent` untouched; no runtime `dependencies`; rules execute only via the
existing `PluginRunner.run`; user files read once as text with `node:fs`; every read and run failure becomes a typed
result for that one rule; threshold and share comparisons are integer comparisons; no `.pipe()`, no `async_hooks`,
no new worker file.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there are no
  lessons to apply.

## Steps

- Extend `RuleErrorCode` in `src/plugin-runner/rule-result.ts`.
- Add `src/plugin-runner/rule-descriptor.ts` and `src/plugin-runner/rule-parameter-error.ts`.
- Add `src/plugin-runner/builtin-rules.ts`.
- Add `src/plugin-runner/rules-directory.ts` and `src/plugin-runner/run-rules.ts`.
- Update `src/plugin-runner/index.ts`.
- Run `npx prettier --write` on each written file, then `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run build`, `npm run check:exports`, `npm run format:check`.

## Files

- `src/plugin-runner/rule-result.ts` — modified. Adds `INVALID_PARAMETER`, `RULES_DIR_UNREADABLE`,
  `RULE_FILE_UNREADABLE`, `DUPLICATE_RULE_ID` to `RuleErrorCode`.
- `src/plugin-runner/rule-descriptor.ts` — new. `RuleDescriptor` type.
- `src/plugin-runner/rule-parameter-error.ts` — new. `RuleParameterError` and the integer / params-object checkers.
- `src/plugin-runner/builtin-rules.ts` — new. `BuiltinRuleId`, `eventLoopLagRule`, `heapGrowthRule`,
  `gcPauseShareRule` with defaults, validation and rule sources.
- `src/plugin-runner/rules-directory.ts` — new. `loadRulesDirectory(dir)`: reads `.js` files once as text.
- `src/plugin-runner/run-rules.ts` — new. `runRules(runner, rules, windows)`: per-id results, sequential, never
  rejects.
- `src/plugin-runner/index.ts` — modified. Public exports for the above; keeps existing exports.

### Explicitly not touched

- `src/plugin-runner/plugin-runner.ts`, `src/plugin-runner/sandbox-process.ts`, `src/plugin-runner/child-script.ts`,
  `src/plugin-runner/sandbox-protocol.ts`, `src/plugin-runner/workers/sandbox-child.ts` — the sandbox is reused
  as-is (limits and existing codes unchanged).
- `src/plugin-runner/index.test.ts` and the `plugin-runner-sandbox.ac*.integration.test.ts` files — existing tests.
- `src/agent/**`, `src/collector/**` — out of scope; collector reused through `import type` only.
- `package.json`, `package-lock.json`, `vitest.config.mts`, `tsconfig*.json`, `eslint.config.mjs`, `scripts/**` —
  no dependency, export-subpath or tooling change is needed.

## Acceptance mapping

- **AC-1** — the test builds windows with distinct `start`s (e.g. 1 s apart, `end = start + 1000`): a run of 3
  windows with `eventLoop.max` above 100 ms, a run of 3 windows with strictly rising `heapUsedLast` (flat heap
  elsewhere), and one window with `gc.totalPause` above 10 % of 1000 ms (> 100_000_000 ns), the other windows low.
  `runRules(runner, [eventLoopLagRule(), heapGrowthRule(), gcPauseShareRule()], windows)` resolves an object with
  keys `argus/event-loop-lag`, `argus/heap-growth`, `argus/gc-pause-share`, each `{ ok: true, findings }` whose
  `windowStart`s are exactly the covered windows' `start`s (run members for lag and heap growth, the single window
  for GC). A second list (low lag, flat heap, low GC) yields `{ ok: true, findings: [] }` for all three.
  Explicit parameters (e.g. `eventLoopLagRule({ thresholdNs, windows })`) reach the source through the `params`
  literal.
- **AC-2** — `eventLoopLagRule({ thresholdNs: -1 })`, `eventLoopLagRule({ windows: 0 })`,
  `heapGrowthRule({ windows: 2.5 })`, `gcPauseShareRule({ thresholdPerMille: '100' })` each throw synchronously a
  `RuleParameterError` with `code === RuleErrorCode.INVALID_PARAMETER` (`'ARGUS_RULE_INVALID_PARAMETER'`), `ruleId`
  the built-in id and `parameter` the offending name (both also in the message). The throw happens inside the
  factory, so no descriptor exists to hand to a runner; a test can additionally show a spy runner's `run` was never
  called.
- **AC-3** — `loadRulesDirectory(tmp)` over `good.js` (returns one finding), `throws.js`, `broken.js` (invalid JS)
  and `notes.txt` resolves `{ ok: true, rules: [3 descriptors with ids broken, good, throws], failures: [] }`.
  `runRules(runner, [...builtins, ...rules], AC-1 windows)` resolves (never rejects) with `good` →
  `{ ok: true, findings: [one] }`, `throws` → `ARGUS_RULE_THREW`, `broken` → `ARGUS_RULE_COMPILE_ERROR` (from the
  sandbox's compile step), plus the same three built-in results as AC-1. Host non-execution: each user file's
  top-level code would set a `globalThis` marker if evaluated; the marker stays unset in the test process because
  the loader only reads text and the sandbox runs in a child process.

## Risks & open questions

- **Names, ids and codes are plan choices**: `eventLoopLagRule` / `heapGrowthRule` / `gcPauseShareRule`, ids
  `argus/event-loop-lag` / `argus/heap-growth` / `argus/gc-pause-share`, params `thresholdNs` / `windows` /
  `thresholdPerMille`, defaults 100 ms / 3 / 3 / 100 ‰, codes `ARGUS_RULE_INVALID_PARAMETER`,
  `ARGUS_RULES_DIR_UNREADABLE`, `ARGUS_RULE_FILE_UNREADABLE`, `ARGUS_RULE_DUPLICATE_ID`. The AC tests drive these;
  they assert codes via the exported `RuleErrorCode`.
- **Throw vs. return for invalid parameters**: configuration throws (matching `validateAlertRules` in the collector),
  as a programmer error at setup time; the run-all helper itself still never rejects.
- **"Consecutive" means adjacent in the given list**, not time-contiguous `start`/`end`. A collector ring with a gap
  (no samples for a window) would count the windows on either side as consecutive. Flagged for `/pharn-grill`.
- **`heapGrowthRule.windows` minimum is 2**, not 1 (a single window cannot show a rise); `windows: 1` is rejected
  with the invalid-parameter code. The SPEC names zero and non-integers; 1 is a plan addition.
- **Unknown parameter keys are rejected** with the invalid-parameter code, so a typo cannot silently fall back to a
  default.
- **GC share overflow**: `thresholdPerMille * d * 1000` stays within safe integers for `d` up to ~9e9 ms at 1000 ‰;
  far beyond any real window.
- **Directory entries**: only regular files (`isFile()`) count, so a symlinked `.js` file is ignored; non-recursive.
- **Runner reuse across rules**: rules run sequentially on one runner; a rule that kills the sandbox child (timeout
  watchdog, crash) is re-forked by the existing sandbox for the next rule, so later rules still run.
