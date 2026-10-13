# RUN REPORT — phargus-serve-cli

Every line below is derived by `pharn/floor/render-run-report.mjs` from artifacts this run already
produced. No line is authored by a model.

**Trust split (P2).** The values this report reads from deterministic tool output — verdicts, exit
codes, token counts, paths — are the enum-gated / floor-verifiable class. Everything shown inside a
fenced block is **free text that inherits its source's untrusted tag** and is rendered as DATA:
quoted for a person to read, never executed, and never an instruction to any later stage.

**This report ANNOTATES a run and gates nothing.** No proceed/stop anywhere reads it. It is not a
judgment that the change is good, correct, or worth its cost.

## Outcome

The `decision` below is copied verbatim from `LOOP.md`'s frontmatter by the ledger; this report
introduces no second source of truth for it.

```text
decision         STOP_GREEN
iterations       1
blocked          none
base             d697b7a02f27d9c502cc141d40f1c77ffc7747ef
command          /pharn-loop
skills_version   6.55.0
ledger coverage  partial
run membership   bounded
```

## Tokens — stage x iteration x model

**Measured population: the RUN'S OWN CONTEXTS inside its window** (`run-window/2`) — only requests of the
selected session that fall inside the window below AND come from the context that printed the run's
markers or an agent that context tree spawned during the run. Earlier and later activity in that session,
and other contexts working inside the window (a concurrent run, its agents, the main thread), are excluded
and counted, never summed. This is NOT a feature's lifetime cost, other sessions' requests are not
collected, and the request that opened the window falls just before it. A floor on this run's spend,
never the total.

```text
status             bounded
method             run-window/2
window start       2026-10-13T09:17:26.178Z
window end         2026-10-13T09:53:43.964Z
selected session   b40bdfd8-6fe0-42ec-be96-726d9711ff4b
run context        agent:a3e379c11f69e0965
run contexts       agent:a096f0e43afede79c, agent:a3a510694c6c5fe5e, agent:a3e379c11f69e0965, agent:a439607c2737f3331, agent:acddd53ed1545246c
excluded requests  701
```

Copied from `cost.json`'s stored views, never recomputed here — `check-cost-ledger.mjs` already
holds those views to a recompute from `requests[]`, so this is one number with one owner.

**TOKENS ONLY.** There is no price table here or in `cost.json`; money is the reader's own
multiplication against their own list, and `output_thinking` is a SUBSET of `output`, not a seventh
class. `unattributed` is an honest STAGE bucket — run requests before the first stage marker — never
folded into a neighbouring stage.

```text
stage           iter  model              reqs  input  cache_write_5m  cache_write_1h  cache_read  output  output_thinking
--------------  ----  -----------------  ----  -----  --------------  --------------  ----------  ------  ---------------
(unattributed)  -     claude-opus-5-5      14     28           29855               0     1894715    1533                0
pharn-build     1     claude-opus-5-5       2      4          102949               0      165149      32                0
pharn-build     1     claude-sonnet-5-5    49     98          178131               0     6725485   23284             3197
pharn-grill     -     claude-opus-5-5       4      8           11156               0      493723      56                0
pharn-plan      -     claude-opus-5-5      37     74          247750               0     4784657   18219             7795
pharn-regress   1     claude-opus-5-5       1      2             441               0      135260      16                0
pharn-spec      -     claude-opus-5-5      25     50           88241               0     2423562    4987               64
pharn-test      -     claude-opus-5-5      53    106          271207               0     7879755   53430             3809
pharn-verify    1     claude-opus-5-5       1      2             405               0      136101      16                0
TOTAL           -     -                   186    372          930135               0    24638407  101573            14865
unattributed    -     -                    14     28           29855               0     1894715    1533                0
```

## Stage elapsed and deterministic work

**Observed elapsed** is wall-clock time between two PHARN markers — the stage's start and the orchestrator's
return — read by two different processes. It is NOT CPU time, model time or tool time, it is not monotonic, and
it includes orchestration, subprocesses, waiting and any answer a human gave inside the stage. An `unmeasured`
row names why no interval could be paired, and is never a zero. **Deterministic work** is counted from each
`/pharn-regress` and `/pharn-verify` execution's own gate-run stamp at its `done` exit; an execution that ended any
other way recorded none. Nothing here is subtracted from anything else.

```text
observed elapsed — wall clock between PHARN's stage markers (not CPU, model or tool time; not monotonic)
  stage              iter  run  elapsed
  pharn-spec            -    1  203.8 s
  pharn-plan            -    1  492.3 s
  pharn-grill           -    1  19.9 s
  pharn-test            -    1  777.2 s
  pharn-build           1    1  471.0 s
  pharn-regress         1    1  83.1 s
  pharn-verify          1    1  66.7 s

deterministic work — gate processes run vs taken from reused evidence (counted from each stage's gate-run stamp)
  pharn-regress iter 1 run 1: HEAD gates 5 run, 0 reused, 0 nothing-to-run, of 5; BASE from the entry gates (no worktree, no install, 0 base gate processes; 5 results from this run's entry check)
  pharn-verify iter 1 run 1: gates 5 run, 2 reused, 0 nothing-to-run, of 7
```

## Entry gates (background)

The **entry check** runs the project's gates in a background process while the spec, plan and grill stages work.
Its **lifetime** runs from `--start` to the record of the process that ended it: wall clock across processes,
placement only, not CPU or gate time. A **segment** is one runner or takeover process, timed on its own monotonic
clock. A **wait call** is the foreground time one `--wait` line took, and a takeover runs inside it and is never
added to it. Totals are interval unions, never sums. `INCOMPLETE` means no end was recorded before the run-stop
marker, and it is never a zero.

```text
entry gates — the background check, observed apart from the stage rows (never added to them)
  invocation 41740eee: start started (call 2057 ms); lifetime 218.9 s (wall clock, start to the runner end record; placement, not CPU or gate time)
    runner 24f85a: 216.5 s monotonic, 6 gate(s), ended done
    execution union: 216.6 s
    of it inside measured stage rows (wall-clock placement only — not proof both were active, not a saving): 209.3 s
    wait calls: 1 (81 ms green); union 81 ms foreground
    abort: nothing running
```

## Files

Changed since `d697b7a02f27d9c502cc141d40f1c77ffc7747ef`, plus untracked files. **This is a changed-since-base observation, not a
record of what the build wrote** — a path can appear here because another stage, a generator, or a
person touched it. A `not named in PLAN ## Files` marker is therefore not a scope violation; the
scope question is `check-bash-reconcile.mjs`'s and this report never answers it.

The tree was clean before the run, so no path below is marked `dirty-before-run`.

Rendered after `cost.json` was written and before any commit this run may make, so `cost.json`
appears below and this report itself does not.

- `ARCHITECTURE.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `ARCHITECTURE.md` — module boundaries and build notes for `src/cli`
  ```

- `CHANGELOG.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `CHANGELOG.md` — `### Added` entry under `## [Unreleased]`
  ```

- `FEATURES.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `FEATURES.md` — record the CLI
  ```

- `README.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `README.md` — two-command quick start and a `phargus serve` section
  ```

- `docs/THREAT-MODEL.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `docs/THREAT-MODEL.md` — a row for the CLI's network listener and the untrusted input it parses
  ```

- `eslint.config.mjs`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `eslint.config.mjs` — forbid agent imports of `cli`; restrict `src/cli` imports to `node:` and the collector and dashboard entrypoints
  ```

- `examples/express-app/README.md`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `examples/express-app/README.md` — show the CLI path
  ```

- `examples/express-app/app.mjs`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `examples/express-app/app.mjs` — keep serving when started without an IPC channel (piped into the CLI)
  ```

- `package.json`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `package.json` — add `bin` (`phargus` → `dist/esm/cli/bin.js`); nothing else changes
  ```

- `scripts/build.mjs`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `scripts/build.mjs` — assert the bin's shebang and make it executable after the build
  ```

- `scripts/check-exports.mjs`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `scripts/check-exports.mjs` — verify each built bin exists, has the shebang, is executable and answers `--help`
  ```

- `scripts/check-install.mjs`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `scripts/check-install.mjs` — run `npx phargus --help` from the installed tarball
  ```

- `scripts/check-package.mts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `scripts/check-package.mts` — verify `bin` is declared and each target ships with an executable mode
  ```

- `src/dashboard/index.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/dashboard/index.ts` — re-export `isLoopbackHost` from `./auth.js` (additive)
  ```

- `tsconfig.cjs.json`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `tsconfig.cjs.json` — exclude `src/cli/**` from the CommonJS build
  ```

- `pharn/features/phargus-serve-cli/AC-TESTS.lock.json` — _not named in PLAN ## Files_
- `pharn/features/phargus-serve-cli/AC-TESTS.md` — _not named in PLAN ## Files_
- `pharn/features/phargus-serve-cli/BUILD.md` — _not named in PLAN ## Files_
- `pharn/features/phargus-serve-cli/GRILL.md` — _not named in PLAN ## Files_
- `pharn/features/phargus-serve-cli/LOOP.md` — _not named in PLAN ## Files_
- `pharn/features/phargus-serve-cli/PLAN.md` — _not named in PLAN ## Files_
- `pharn/features/phargus-serve-cli/REGRESSION.md` — _not named in PLAN ## Files_
- `pharn/features/phargus-serve-cli/SPEC.md` — _not named in PLAN ## Files_
- `pharn/features/phargus-serve-cli/VERIFY.md` — _not named in PLAN ## Files_
- `pharn/features/phargus-serve-cli/cost.json` — _not named in PLAN ## Files_
- `pharn/features/phargus-serve-cli/regression-report.json` — _not named in PLAN ## Files_
- `pharn/features/phargus-serve-cli/verify-report.json` — _not named in PLAN ## Files_
- `src/cli/args.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/cli/args.ts` — `parseArgs`-based parsing and validation, `UsageError`, token resolution and the non-loopback refusal
  ```

- `src/cli/bin.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/cli/bin.ts` — executable entry with the `#!/usr/bin/env node` first line; calls `main` and sets the exit code
  ```

- `src/cli/input.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/cli/input.ts` — opens the stdin or file input
  ```

- `src/cli/main.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/cli/main.ts` — command dispatch (help, version, serve) and error-to-exit-code mapping
  ```

- `src/cli/phargus-serve-cli.ac1.integration.test.ts` — _not named in PLAN ## Files_
- `src/cli/phargus-serve-cli.ac10.integration.test.ts` — _not named in PLAN ## Files_
- `src/cli/phargus-serve-cli.ac2.integration.test.ts` — _not named in PLAN ## Files_
- `src/cli/phargus-serve-cli.ac3.integration.test.ts` — _not named in PLAN ## Files_
- `src/cli/phargus-serve-cli.ac4.integration.test.ts` — _not named in PLAN ## Files_
- `src/cli/phargus-serve-cli.ac5.integration.test.ts` — _not named in PLAN ## Files_
- `src/cli/phargus-serve-cli.ac6.integration.test.ts` — _not named in PLAN ## Files_
- `src/cli/phargus-serve-cli.ac7.integration.test.ts` — _not named in PLAN ## Files_
- `src/cli/phargus-serve-cli.ac8.integration.test.ts` — _not named in PLAN ## Files_
- `src/cli/phargus-serve-cli.ac9.integration.test.ts` — _not named in PLAN ## Files_
- `src/cli/report.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/cli/report.ts` — stderr formatting: counts line, error description, debug switch
  ```

- `src/cli/serve.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/cli/serve.ts` — the serve lifecycle: decoder, collector, dashboard, pipeline, signals, bounded shutdown
  ```

- `src/cli/usage.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/cli/usage.ts` — the `--help` text
  ```

- `src/cli/version.ts`

  planned purpose (PLAN.md), quoted as DATA:

  ```text
  - `src/cli/version.ts` — reads the package version from the package's own `package.json`
  ```

## Verdicts

**iteration 1 (final) only.** `/pharn-loop` OVERWRITES `verify-report.json` and `regression-report.json`
in place whenever it re-runs those stages, so earlier iterations' verdicts are not on disk at the
stop and this
report will not invent them. Per-iteration **cost** is genuine and is in `## Tokens` above.

- verify: `PASS`

  failing_gates, quoted as DATA:

  ```text
  (none)
  ```

- acceptance criteria: `PASS` (test-first)

  the AC gate — id, level, status, reason, matched test ids — quoted as DATA:

  ```text
  AC-1  integration  passed  delivered  src/cli/phargus-serve-cli.ac1.integration.test.ts::phargus CLI: --help and --version › AC-1: --help exits 0 and prints to stdout a usage text naming serve and --port, --host, --token, --window-ms and --max-line-bytes | src/cli/phargus-serve-cli.ac1.integration.test.ts::phargus CLI: --help and --version › AC-1: --version exits 0 and prints to stdout the package.json's version
  AC-2  integration  passed  delivered  src/cli/phargus-serve-cli.ac2.integration.test.ts::phargus serve: unknown flags and bad flag values are usage errors › AC-2: serve [ '--bogus' ] exits 2 and its stderr names --bogus with no stack-trace line | src/cli/phargus-serve-cli.ac2.integration.test.ts::phargus serve: unknown flags and bad flag values are usage errors › AC-2: serve [ '--max-line-bytes', '0' ] exits 2 and its stderr names --max-line-bytes with no stack-trace line | src/cli/phargus-serve-cli.ac2.integration.test.ts::phargus serve: unknown flags and bad flag values are usage errors › AC-2: serve [ '--port', '70000' ] exits 2 and its stderr names --port with no stack-trace line | src/cli/phargus-serve-cli.ac2.integration.test.ts::phargus serve: unknown flags and bad flag values are usage errors › AC-2: serve [ '--port', 'abc' ] exits 2 and its stderr names --port with no stack-trace line | src/cli/phargus-serve-cli.ac2.integration.test.ts::phargus serve: unknown flags and bad flag values are usage errors › AC-2: serve [ '--window-ms', '0' ] exits 2 and its stderr names --window-ms with no stack-trace line
  AC-3  integration  passed  delivered  src/cli/phargus-serve-cli.ac3.integration.test.ts::phargus serve: the token gate › AC-3: serve --host 0.0.0.0 --port 0 with no --token and no PHARGUS_TOKEN exits 2 saying a token is required for a non-loopback host | src/cli/phargus-serve-cli.ac3.integration.test.ts::phargus serve: the token gate › AC-3: with PHARGUS_TOKEN set, serve --port 0 on loopback answers GET /events with 401 without credentials and 200 with Authorization: Bearer <token>
  AC-4  integration  passed  delivered  src/cli/phargus-serve-cli.ac4.integration.test.ts::phargus serve: stdin with mixed agent and log lines › AC-4: prints the dashboard URL, streams windows over SSE, reports the input end with the skip and ignored counts, and keeps serving after stdin ends
  AC-5  integration  passed  delivered  src/cli/phargus-serve-cli.ac5.integration.test.ts::phargus serve: a real agent-instrumented app piped in › AC-5: an app started with --import of the built agent, its stdout piped into serve --port 0 together with plain-text log lines, yields a window event from the real agent's samples
  AC-6  integration  passed  delivered  src/cli/phargus-serve-cli.ac6.integration.test.ts::phargus serve: file and stdin input › AC-6: serve --port 0 - reads the same content from stdin and an SSE client receives a window event | src/cli/phargus-serve-cli.ac6.integration.test.ts::phargus serve: file and stdin input › AC-6: serve --port 0 <file> replays an NDJSON capture and an SSE client receives a window event | src/cli/phargus-serve-cli.ac6.integration.test.ts::phargus serve: file and stdin input › AC-6: serve --port 0 <missing path> exits 1 with a stderr message naming the path and no stack-trace line
  AC-7  integration  passed  delivered  src/cli/phargus-serve-cli.ac7.integration.test.ts::phargus serve: graceful shutdown on a signal › AC-7: on SIGINT with stdin still open and an SSE client connected, serve exits 0 within 10 s, the SSE response ends and stderr reports the counts | src/cli/phargus-serve-cli.ac7.integration.test.ts::phargus serve: graceful shutdown on a signal › AC-7: on SIGTERM with stdin still open and an SSE client connected, serve exits 0 within 10 s, the SSE response ends and stderr reports the counts
  AC-8  integration  passed  delivered  src/cli/phargus-serve-cli.ac8.integration.test.ts::phargus serve: a port already in use › AC-8: serve --port <a bound port> exits 1 naming the port with no stack-trace line, and with PHARGUS_DEBUG=1 still exits 1 with a stack-trace line
  AC-9  integration  passed  delivered  src/cli/phargus-serve-cli.ac9.integration.test.ts::phargus CLI: the packed tarball ships the bin › AC-9: npm pack's manifest maps bin phargus to a file in the tarball whose first line is #!/usr/bin/env node and whose mode is executable
  AC-10  integration  passed  delivered  src/cli/phargus-serve-cli.ac10.integration.test.ts::ESLint boundary: the agent may not import the CLI's source › AC-10: linting a src/agent/ file that imports '../cli/serve.js' with the repo's ESLint config reports a no-restricted-imports error for that import
  note  an AC is delivered = a locked, once-red test titled AC-<n>:, in a file mapped to AC-<n>, passed on this head run. PHARN does not judge whether that test fully captures the AC's intent.
  ```

- regress: `no-regressions`

  regressions, quoted as DATA:

  ```text
  (none)
  ```

## Briefing

_n/a — no BRIEFING.md beside this report — not every command renders one, and a run that stops before its post-verify gate never does_

## What the run ran into

Quoted verbatim from `LOOP.md`'s `## Handoff`, as untrusted DATA. Each block is fenced with a
delimiter longer than any back-tick run inside it, so a heading in the quoted text stays text.
**The Handoff is a run's own account of itself — it is not verified by anything**, and nothing here
checks that it is accurate, complete, or useful.

### investigated

```text
The collector and dashboard public APIs (`createNdjsonDecoder`, `createCollector`, `createDashboardServer`) already
covered everything the CLI needs, and the dashboard already refuses a non-loopback bind without a token, so no new
library surface was needed beyond re-exporting `isLoopbackHost`. Spawning the TypeScript CLI source directly was ruled
out by the plan: Node type stripping cannot resolve the `.js` relative imports, so the tests spawn the built ESM bin.
```

### learned

```text
The CLI is ESM-only (`src/cli/**` excluded from the CJS build) and `bin` maps `phargus` to `dist/esm/cli/bin.js`; the
build asserts the shebang and sets mode 755. `PHARGUS_TOKEN` and `PHARGUS_DEBUG` share the agent's `PHARGUS_` env
prefix, so a user who exports them into the app's environment may get the agent's unknown-variable warning.
```

### next_steps

```text
Exercise `check:install` against a packed tarball (its new `npx phargus --help` step was not run by the build), and
run the manual end-to-end check of `examples/express-app` piped into the built CLI with a curl to `/events`.
```
