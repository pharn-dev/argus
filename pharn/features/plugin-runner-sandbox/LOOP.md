---
decision: STOP_GREEN_QUICK
iterations: 1
cap: 3
mode: quick
commit: 37b78463310d1dbfcdd44fd0f2a567d2a0703f41
date: 2026-10-07
---

# LOOP — plugin-runner-sandbox

- Stages: `/pharn-spec --quick --model-approve` (agent:opus), `/pharn-plan` (agent:opus), `/pharn-grill --quick`
  (inline by policy; chain GREEN, lessons GREEN — see `GRILL.md`), `/pharn-test --unattended` (agent:opus;
  `READY test-first`), then one `build → scope check → verify` iteration (build agent:sonnet; verify inline by
  policy).
- Entry gates (lint, format:check, base:test, test, typecheck, build): all green at entry.
- Iteration 1: build `done gate:pass`; scope check exit 0 (nothing escaped); verify `PASS`; freshness `FRESH`;
  `check-loop.mjs` exit 0 `STOP_GREEN_QUICK`.
- No standing reds.
- Pointers: `GRILL.md`, `BUILD.md`, `VERIFY.md`. No `REGRESSION.md` (quick mode).

## Outcome

- commit: committed pharn-loop/plugin-runner-sandbox
- spec: approved by the model
- blocked: none
- ac-tests: test-first

## Not checked in quick mode

- regressions outside the feature — no base comparison ran; the scope check did;
- the plan interrogation — `/pharn-grill --quick` ran its two floor stops only;
- `RUN-REPORT.md` — not rendered; `cost.json` is.

## Handoff

### investigated

isolated-vm needs `--no-node-snapshot` on Node 22+, so the isolate lives in a forked child process
(`execArgv: ['--no-node-snapshot']`) rather than in the host; the host keeps a backup kill timer so a hung child
can never block it. isolated-vm 6.2.0 installed as a devDependency from prebuilds with no native-build problem.

### learned

The child script cannot share runtime code with sibling `.ts` files under Node type stripping (type-only imports),
so `workers/sandbox-child.ts` carries its own copy of the findings validator and literal error-code strings; the two
copies must be kept in sync. In tests the child runs from its `.ts` source, which needs Node 22.18+ type stripping.

### next_steps

Next S6 slice per `ROADMAP.md`: the bundled rule library (common leak / latency patterns) on top of
`createPluginRunner`, then the Node Permission Model applied to the agent.
