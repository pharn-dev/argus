# BUILD — analyzer-worker-pool

- Plan built: `pharn/features/analyzer-worker-pool/PLAN.md` (spec_content_hash 438827a9...722f).
- Chain gate: GREEN (`check-plan-spec-agree.mjs`, exit 0).
- Test-stage gate: `READY test-first` (verbatim token from `check-test-stage.mjs`, exit 0).
- Writes-scope set from the plan (8 paths): `src/analyzer/worker-protocol.ts`, `worker-errors.ts`, `worker-file.ts`,
  `worker-pool.ts`, `heap-snapshot.ts`, `workers/heap-snapshot.worker.ts`, `workers/test-task.worker.ts`, `index.ts`.
- Floor status: GREEN — `npm run typecheck`, `lint`, `format:check`, `test` (35 files, 42 tests), `build`, `check:exports` all exit 0.
- Files written: the 8 paths above (7 new, `index.ts` modified).
- Deviation noted: `worker-file.ts` trusts `__dirname` only when absolute, because `node -e` defines `__dirname` as `.` even in ESM.

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is
`/pharn-regress` / `/pharn-verify` + the human.
