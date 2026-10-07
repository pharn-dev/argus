---
decision: STOP_GREEN_QUICK
iterations: 1
cap: 3
mode: quick
commit: a91fc3ce3828bb726cff94cc15e4e1bfdddca0cf
date: 2026-10-07
---

# LOOP — example-worker-pool

- Invoked as `/pharn-loop --quick`; the SPEC's pinned kind read `quick`. Stages: `/pharn-spec --quick
  --model-approve` (agent:opus) → `/pharn-plan` (agent:opus) → `/pharn-grill --quick` (inline, policy) →
  entry gates (green: lint, format:check, base:test, test, typecheck, build) → `/pharn-test --unattended`
  (agent:opus; `check-test-stage.mjs --require-test-first` READY test-first) → iteration 1: `/pharn-build`
  (agent:sonnet, `done gate:pass`) → quick scope check → `/pharn-verify` (inline, policy).
- Iteration 1: scope check exit 0 (escaped: none); verify `PASS`; `check-loop-fresh.mjs` FRESH (mode quick);
  `check-loop.mjs` exit 0, decision `STOP_GREEN_QUICK`.
- Standing reds: none.
- Pointers: `GRILL.md` (quick, floor stops only), `VERIFY.md` / `verify-report.json`, `BUILD.md`. No
  `REGRESSION.md` (quick mode).

## Not checked in quick mode

- regressions outside the feature — no base comparison ran; the scope check did;
- the plan interrogation — `/pharn-grill --quick` ran its two floor stops only;
- `RUN-REPORT.md` — not rendered; `cost.json` is.

## Outcome

commit: committed pharn-loop/example-worker-pool
spec: approved by the model
blocked: none
ac-tests: test-first

## Handoff

### investigated

The vitest `include` covers only `src/**/*.test.ts`, so the plan placed the three AC integration tests under
`src/analyzer/` instead of widening the test infrastructure. A TypeScript example was ruled out because
`tsconfig.json` includes `**/*.ts` and typecheck would fail on a fresh clone before `dist` exists; the example is
plain ESM `.mjs` with no `package.json`, resolving `argus/<subpath>` through the root package's self-reference.

### learned

The example ran by hand on Node 22.19.0 exits 0 and prints 4 completed CPU tasks, a heap summary (~94k nodes)
with five top entries, and a non-zero main-thread tick count during analysis. The AC-1/AC-2 tests rebuild
`dist` themselves when it is stale (mtime comparison, serialized by a tmpdir lock), because `scripts/build.mjs`
starts with `rm -rf dist`.

### next_steps

Fix the README wording in `examples/worker-pool/README.md`: `ARGUS_OUTPUT=none` disables the agent entirely
(`src/agent/auto-start.ts`), not merely silences its NDJSON, and a file output must be an absolute path
(`src/agent/config-schema.ts`). Optionally move the AC tests next to the example once the vitest include is
widened in a test-infra change.
