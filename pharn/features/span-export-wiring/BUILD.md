# BUILD — span-export-wiring

- Plan built: `pharn/features/span-export-wiring/PLAN.md`
- Chain gate: GREEN (`check-plan-spec-agree.mjs`)
- Test-stage gate: `READY test-first`
- Scope set (fix #7, from the plan's `## Files`): 13 paths
  - `src/agent/trace-id.ts`, `src/agent/span-buffer.ts`, `src/agent/http-tracing.ts`, `src/agent/span-record.ts`,
    `src/agent/span-export.ts`, `src/agent/auto-start.ts`, `src/agent/index.ts`
  - `src/collector/span-router.ts`, `src/collector/collector-subscribers.ts`, `src/collector/collector.ts`,
    `src/collector/index.ts`
  - `src/dashboard/sse-format.ts`, `src/dashboard/server.ts`
- Gate: passed (`build-gate.mjs --mode full`, exit 0; targeted run exit 0)
- Files written: the 13 paths above (`span-record.ts`, `span-export.ts`, `span-router.ts` new; the rest modified)
- skills: mode=none (catalogue exit 0)

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
