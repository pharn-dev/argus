# BUILD — collector-foreign-records

- plan built: `pharn/features/collector-foreign-records/PLAN.md` (rebuild: the earlier build was set aside so the AC tests could be re-run red)
- chain gate: GREEN (`check-plan-spec-agree.mjs`)
- test-stage gate: `READY test-first`
- skills: mode=none (`catalogue-installed-skills.mjs` exit 0, no installed skills)

## Writes-scope set (from the plan's `## Files`)

`src/collector/record-guard.ts`, `src/collector/ndjson-decoder.ts`, `src/collector/collector.ts`,
`src/collector/index.ts`, `README.md`, `examples/express-app/index.mjs`,
`examples/express-app/app.mjs`, `examples/express-app/README.md`, `ARCHITECTURE.md`, `FEATURES.md`,
`docs/LIMITS.md`, `docs/THREAT-MODEL.md`, `CHANGELOG.md`.

## Files written

- New: `src/collector/record-guard.ts`, `src/collector/ndjson-decoder.ts`.
- Edited: `src/collector/collector.ts` (`onIgnored` option, `ignored` getter, guard stage first in
  `consume()`'s `pipeline()`, `consume()` input widened to `AsyncIterable<unknown>`),
  `src/collector/index.ts` (decoder, `DEFAULT_MAX_LINE_BYTES`, ignored-record types).
- Reviewed and kept from the earlier build, unchanged (they already match the plan, no duplicate
  entries): `README.md`, `examples/express-app/index.mjs`, `examples/express-app/app.mjs`,
  `examples/express-app/README.md`, `ARCHITECTURE.md`, `FEATURES.md`, `docs/LIMITS.md`,
  `docs/THREAT-MODEL.md` (row H1), `CHANGELOG.md` (`### Fixed` under `[Unreleased]`).

## Gate result: passed (`build-gate.mjs --mode full` exit 0)

`test`, `lint`, `format:check`, `typecheck`, `build` all exit 0. The targeted run over the three AC
test files also exited 0. Outside the gate: `npm run build` and `npm run check:exports` both exit 0.

built within the named scope from a current approved plan — this is NOT a judgment that the code is
correct; that is `/pharn-regress` / `/pharn-verify` + the human.
