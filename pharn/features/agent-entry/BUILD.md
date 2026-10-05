# BUILD — agent-entry

- Plan built: `pharn/features/agent-entry/PLAN.md`
- Chain gate: GREEN (`check-plan-spec-agree.mjs`)
- Test-stage gate: `READY test-first` (`check-test-stage.mjs`)
- Writes-scope set (from plan `## Files`): `src/agent/agent-output.ts`, `src/agent/auto-start.ts`, `src/agent/auto.ts`, `package.json`
- Project gate: GREEN (`npm run build`, `check:exports`, `typecheck`, `lint`, `npm test` all exit 0; 23 files / 30 tests pass)
- Files written: the three new `src/agent/` files above; `package.json` `exports["./agent"]` repointed to `auto.*`.
- Deviation from plan text: `auto-start.ts` also listens for `error` on the destination stream, because `pipeline()` does not settle while the exporter's source is idle (a missing output directory otherwise went unreported).

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
