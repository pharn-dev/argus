# BUILD — collector-persistence

- Plan built: `pharn/features/collector-persistence/PLAN.md`.
- Chain gate: GREEN (`check-plan-spec-agree.mjs`).
- Test-stage gate: `READY test-first` (`check-test-stage.mjs`, verbatim).
- Writes-scope set from the plan's `## Files`: `src/collector/window-codec.ts`, `src/collector/window-store.ts`, `src/collector/collector.ts`, `src/collector/index.ts`.
- Floor status: GREEN (`npm run typecheck`, `npm run lint`, `npm test` 35 files / 42 tests, `npm run build`, `npm run check:exports`, `npm run format:check`).
- Installed skills: none (`count:0`). No seam touched.

## Files written

- `src/collector/window-codec.ts` (new)
- `src/collector/window-store.ts` (new)
- `src/collector/collector.ts` (modified)
- `src/collector/index.ts` (modified)

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
