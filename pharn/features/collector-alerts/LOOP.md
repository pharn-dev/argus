---
decision: STOP_GREEN_QUICK
iterations: 1
cap: 3
mode: quick
commit: b5ec8a020398f3b8c1f92eeaaf8f569325f54c4a
date: 2026-10-05
---

# LOOP — collector-alerts

- Stages: `/pharn-spec --quick --model-approve` (agent:opus), `/pharn-plan` (agent:opus), `/pharn-grill --quick`
  (inline:floor-only; chain GREEN, lessons GREEN — see `GRILL.md`), `/pharn-test --unattended` (agent:opus;
  `READY test-first`), then one `build → scope check → verify` iteration (build agent:sonnet; verify inline by
  policy).
- Iteration 1: build `done gate:pass`; scope check exit 0 (nothing escaped); verify `PASS` (no failing gates,
  completeness complete, AC gate PASS — AC-1, AC-2, AC-3 passed); freshness `FRESH`; `check-loop.mjs` exit 0
  `STOP_GREEN_QUICK`.
- No standing reds.
- Pointers: `GRILL.md`, `BUILD.md`, `VERIFY.md`. No `REGRESSION.md` (quick mode).

## Outcome

- commit: committed pharn-loop/collector-alerts
- spec: approved by the model
- blocked: none
- ac-tests: test-first

## Not checked in quick mode

- regressions outside the feature — no base comparison ran; the scope check did;
- the plan interrogation — `/pharn-grill --quick` ran its two floor stops only;
- `RUN-REPORT.md` — not rendered; `cost.json` is.

## Handoff

### investigated

Alerts are exposed as a second bounded ring buffer on the collector (sized by `capacity`), not as a callback or a
Readable; more than `capacity` alerts between reads drops the oldest.

### learned

The alert evaluator is edge-triggered per rule (consecutive-breach counter up to `forWindows`); invalid rules throw
synchronously at construction with the rule id in the message.

### next_steps

Next S2 slice: alert sinks (stdout, append-only file, webhook via Node core `http`/`fetch`) fed by the alert stream.
