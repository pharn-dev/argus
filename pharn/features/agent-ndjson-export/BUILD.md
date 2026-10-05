# BUILD — agent-ndjson-export

- Plan built: `pharn/features/agent-ndjson-export/PLAN.md`.
- Test-stage gate (`check-test-stage.mjs`): `READY test-first — the mapping holds and the lock records a red run over the pinned tests`.
- Chain gate (`check-plan-spec-agree.mjs`): GREEN.
- Writes-scope set from the plan (`--from-plan`): `src/agent/ndjson-encoder.ts`, `src/agent/bounded-queue.ts`, `src/agent/ndjson-exporter.ts`, `src/agent/index.ts`.
- Project gate: `npm run typecheck`, `lint`, `test` (11 files, 12 tests), `build`, `check:exports` all exit 0 (GREEN).
- Files written: the four above (index.ts gained three re-export lines).

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
