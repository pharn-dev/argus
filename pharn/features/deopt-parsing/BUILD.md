# BUILD — deopt-parsing

- plan built: `pharn/features/deopt-parsing/PLAN.md` (spec_id `deopt-parsing`)
- chain gate: GREEN (`check-plan-spec-agree.mjs`, exit 0)
- test-stage gate: `READY test-first` (`check-test-stage.mjs`, exit 0)
- scope set (from the plan's `## Files`, 8 paths):
  - `src/agent/deopt-parser.ts`
  - `src/agent/index.ts`
  - `src/agent/__fixtures__/deopt/node22.txt`
  - `src/agent/__fixtures__/deopt/node24.txt`
  - `src/agent/__fixtures__/deopt/node22-verbose.txt`
  - `src/agent/__fixtures__/deopt/node24-verbose.txt`
  - `src/agent/__fixtures__/deopt/lazy22-verbose.txt`
  - `src/agent/__fixtures__/deopt/lazy24-verbose.txt`
- gate: passed (`build-gate.mjs --mode full`, exit 0: test, lint, format:check, typecheck, build); targeted run exit 0
- files written: the eight paths above (fixtures re-created from the scratchpad `samples/` set; their SHA-256 values equal the plan's pinned values)
- skills: mode=none (catalogue exit 0, no installed skills)

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
