# BUILD: stack-symbolization

- Plan built: `pharn/features/stack-symbolization/PLAN.md` (iteration 1, quick mode).
- Chain gate: GREEN (`check-plan-spec-agree.mjs`).
- Test-stage gate: `READY test-first — the mapping holds and the lock records a red run over the pinned tests`.
- Writes-scope set (from the plan's `## Files`):
  - `src/analyzer/stack-symbolization.ts`
  - `src/analyzer/source-map-error.ts`
  - `src/analyzer/symbolize-protocol.ts`
  - `src/analyzer/workers/symbolize.worker.ts`
  - `src/analyzer/index.ts`
- Gate result: passed (`build-gate.mjs --mode full`, exit 0; test, lint, format:check, typecheck, build all exit 0). A first full run was red (lint and typecheck on the worker's `findEntry` result type); fixed within scope and re-run.
- Files written: the four new files above, plus `src/analyzer/index.ts` modified (re-exports).
- skills: mode=none (catalogue exit 0, no installed skills).
- Seams: none touched (no seam walk).

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
