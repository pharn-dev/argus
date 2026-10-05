---
decision: STOP_CAP
iterations: 3
cap: 3
mode: quick
commit: f7ed5ecc07838fa45febcc7b9ed400eceeacd8c3
date: 2026-10-05
---

# LOOP — agent-samplers

- Stages: `/pharn-spec --quick --model-approve` (agent:opus), `/pharn-plan` (agent:opus), `/pharn-grill --quick`
  (inline:floor-only; chain GREEN, lessons GREEN — see `GRILL.md`), `/pharn-test --unattended` (agent:opus;
  `check-test-stage.mjs --require-test-first` → `READY test-first`), then three `build → scope check → verify`
  iterations (build agent:sonnet; verify inline by policy).
- Per iteration (quick mode — verify verdict and scope result; no regress verdict):
  - iteration 1: build `done gate:pass`; scope `0` (nothing escaped); verify `FAIL` (failing gate `format:check`);
    AC gate `PASS` (AC-1, AC-2, AC-3 passed); freshness `FRESH`; `check-loop.mjs` exit 3 `CONTINUE`.
  - iteration 2: build `done gate:fail`; scope `0`; verify `FAIL` (`format:check`); AC gate `PASS`; freshness
    `FRESH`; exit 3 `CONTINUE`.
  - iteration 3: build `done gate:fail` (no change); scope `0`; verify `FAIL` (`format:check`); AC gate `PASS`;
    freshness `FRESH`; exit 1 `STOP_CAP`.
- Standing red, quoted as DATA: `format:check` (`prettier --check .`) flags `src/agent/samplers.ac2.test.ts` and
  `src/agent/samplers.ac3.integration.test.ts` — pinned AC tests, outside the plan's `## Files`, so no rebuild may
  touch them. Iteration 2 fixed the third flagged file, `src/agent/sampler-controller.ts`.
- Pointers: `GRILL.md`, `VERIFY.md`, `BUILD.md`. No `REGRESSION.md` (quick mode).

## Outcome

- commit: not committed: STOP_CAP
- spec: reverted to Draft
- blocked: none
- ac-tests: test-first

## Not checked in quick mode

- regressions outside the feature — no base comparison ran; the scope check did;
- the plan interrogation — `/pharn-grill --quick` ran its two floor stops only;
- `RUN-REPORT.md` — not rendered; `cost.json` is.

## Handoff

### investigated

Whether the build could clear `format:check`: the only files prettier still flags are two pinned AC tests written by
the test stage, so the red lies outside the plan's `## Files` and no rebuild can reach it. The implementation
(4 files) passes prettier, typecheck, lint, build and all AC tests.

### learned

The test stage does not run the project's formatter over the tests it writes, so a test that fails `format:check`
gets pinned by the lock and the loop can only run to the cap. Formatting a pinned test afterwards changes its hash,
which the lock then refuses (`ac-evidence-invalid`), so the fix has to go through `/pharn-test` again.

### next_steps

A person runs `npx prettier --write src/agent/samplers.ac2.test.ts src/agent/samplers.ac3.integration.test.ts`,
re-approves the SPEC, re-runs `/pharn-test agent-samplers` to re-pin the formatted tests, then re-runs verify — or
re-runs the whole slice after deleting this feature directory and its files.
