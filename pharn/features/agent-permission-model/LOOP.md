---
decision: STOP_GREEN_QUICK
iterations: 1
cap: 3
mode: quick
commit: 41cc8fb4c95ede8c5d36aaa890ccf0924430a235
date: 2026-10-07
---

# LOOP — agent-permission-model

- Invoked as `/pharn-loop --quick`. Stages: `/pharn-spec --quick --model-approve` (agent:opus), `/pharn-plan`
  (agent:opus), `/pharn-grill --quick` (inline, policy), `/pharn-test --unattended` (agent:opus), then iteration 1:
  `/pharn-build` (agent:sonnet, `done gate:pass`), the quick scope check, `/pharn-verify` (inline, policy).
- Entry gates (lint, format:check, base:test, test, typecheck, build) were green on the base tree.
- Iteration 1: scope check exit 0 (no escaped path); verify `PASS`; `check-loop-fresh.mjs` `FRESH`;
  `check-loop.mjs` exit 0, `STOP_GREEN_QUICK`.
- No standing reds.
- Pointers: `GRILL.md`, `VERIFY.md`, `verify-report.json`, `BUILD.md`. No `REGRESSION.md` (quick mode).

## Outcome

- commit: committed pharn-loop/agent-permission-model
- spec: approved by the model
- blocked: none
- ac-tests: test-first

## Not checked in quick mode

- **regressions outside the feature** — no base comparison ran; the scope check did.
- **the plan interrogation** — `/pharn-grill --quick` ran its two floor stops only.
- **`RUN-REPORT.md`** — not rendered; `cost.json` is.

## Handoff

### investigated

Node Permission Model behaviour on Node 22.19.0 and 24.13.1, by experiment: `process.permission` is undefined without
the flag; `has('fs.write', <relative path>)` is false even when the absolute path is granted; an unknown scope returns
false; `--experimental-permission` is still accepted on 22.19 but is a bad option on 24; the agent itself spawns no
worker or child process, so it needs no `--allow-worker` / `--allow-child-process`.

### learned

The pre-build agent already survived a denied NDJSON file write (one `[argus] agent disabled:` line, exit 0), so the
AC-2 test asserts that the line names `fs.write` and the absolute output path, which the raw ERR_ACCESS_DENIED message
does not. The heap-snapshot permission check must run before the directory stat/access checks, or a denial surfaces as
a generic directory error.

### next_steps

A person reviews the `pharn-loop/agent-permission-model` branch. Not covered by this slice: the collector's disk
persistence and file alert sink, and the analyzer worker pool, under `--permission` (they are outside src/agent).
