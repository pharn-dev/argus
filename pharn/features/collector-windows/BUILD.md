# BUILD — collector-windows

- Plan built: `pharn/features/collector-windows/PLAN.md`
- Chain gate (`check-plan-spec-agree.mjs`): GREEN
- Test-stage gate (`check-test-stage.mjs`): `READY test-first`
- Writes-scope set from the plan's `## Files`: `src/collector/window.ts`, `src/collector/window-aggregator.ts`, `src/collector/ring-buffer.ts`, `src/collector/collector.ts`, `src/collector/index.ts`
- Floor status: GREEN (`npm run typecheck`, `npm run lint`, `npm test` 26 files / 33 tests, `npm run build`, `npm run check:exports`)
- Files written: the five above (all prettier-formatted)

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
