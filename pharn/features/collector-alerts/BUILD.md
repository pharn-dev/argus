# BUILD — collector-alerts

- Plan built: `pharn/features/collector-alerts/PLAN.md`
- Chain gate: GREEN (`check-plan-spec-agree.mjs`)
- Test-stage gate: `READY test-first` (`check-test-stage.mjs`)
- Writes-scope set from the plan's `## Files`: `src/collector/alert-rules.ts`, `src/collector/alert-evaluator.ts`, `src/collector/collector.ts`, `src/collector/index.ts`
- Floor status: GREEN (typecheck, lint, test 36/36, build, check:exports, prettier)
- Files written: the four above (alert-rules.ts and alert-evaluator.ts new; collector.ts and index.ts modified)

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
