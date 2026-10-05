# BUILD — agent-backpressure-probes

- Plan built: `pharn/features/agent-backpressure-probes/PLAN.md`
- Chain gate (`check-plan-spec-agree.mjs`): GREEN
- Test-stage gate (`check-test-stage.mjs`): `READY test-first`
- Writes-scope set from the plan's `## Files` (6 paths):
  - `src/agent/backpressure-exclusion.ts`
  - `src/agent/stack-site.ts`
  - `src/agent/backpressure-probe.ts`
  - `src/agent/ndjson-exporter.ts`
  - `src/agent/sampler-controller.ts`
  - `src/agent/index.ts`
- Reconcile baseline anchored at build start (`reconcile-baseline.mjs --anchor --by pharn-build`, 595 paths, scope 6 entries).
- Installed skills (`scan-installed-skills.mjs`): count 0. Seam step: no seam touched, no-op.
- Floor status: GREEN (`npm run typecheck`, `lint`, `test` 22/22, `build`, `check:exports`, `format:check` all exit 0)
- Re-anchor pass: no source file needed changing; the implementation from the prior iterations was already complete.
- Files written: none in this pass (the six above were written in earlier iterations: three new, three modified)

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
