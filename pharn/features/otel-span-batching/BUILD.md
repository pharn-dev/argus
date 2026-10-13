# BUILD — otel-span-batching

> ADVISORY: a thin record. It is not a judgment that the code is correct.

- Plan built: `pharn/features/otel-span-batching/PLAN.md` (spec_content_hash `450a23f0…52ed5c29`, carried from the SPEC).
- Chain gate: GREEN, by `check-plan-spec-agree.mjs` (re-run at build time).
- Test-stage gate (Step 0, verbatim): `READY test-first — the mapping holds and the lock records a red run over the pinned tests`
- Writes-scope set from the plan's `## Files` (13 paths): `src/otel/otlp-pending-items.ts`, `src/otel/otlp-drop-reporter.ts`, `src/otel/otlp-batch-queue.ts`, `src/otel/otlp-exporter-options.ts`, `src/otel/otlp-trace-exporter.ts`, `src/otel/otlp-exporter.ts`, `src/otel/otlp-bounds.integration.test.ts`, `src/otel/otel-trace-export.ac3.integration.test.ts`, `src/otel/otel-metrics-export.ac3.integration.test.ts`, `docs/THREAT-MODEL.md`, `FEATURES.md`, `README.md`, `CHANGELOG.md`.
- Gate result: passed. `build-gate.mjs --mode full` exited 0 (test, lint, format:check, typecheck, build all exit 0). The targeted run over the 13 declared test files also exited 0.
- skills: mode=none (catalogue exit 0, no installed skills).
- Seams: none touched (Node core only); Step 2c was a no-op.

## Iteration 2 (rebuild after regress)

- Input: `verify-report.json` had no failing gates, no missing files and all 10 ACs passed; `regression-report.json` listed one regression, the `test` gate (base exit 0, head exit 1).
- Cause read from the regress head log: 3 timeouts (5000 ms) in `src/release/publish-workflow.ac3.integration.test.ts`, which spawns `scripts/check-publish-workflow.mjs`. That file is outside `## Files` and does not touch `src/otel`. Run alone it passes (7 tests); the full `test` gate at this head passed (exit 0) in this iteration and in verify.
- No file was changed in this iteration: nothing in the declared scope explains or can fix a load-dependent timeout in an unrelated spawn test, and the pinned AC tests are not to be edited. Chain gate and test-stage gate (`READY test-first`) were re-run and are GREEN.
- Gate result: passed. `build-gate.mjs --mode full` exited 0 (test, lint, format:check, typecheck, build all exit 0).

## Iteration 3 (rebuild after verify)

- Input: `verify-report.json` had `failing_gates: ["test"]`, no missing files, all 10 ACs passed; `regression-report.json` listed the `test` gate. Chain gate and test-stage gate (`READY test-first`) re-run: GREEN. Writes-scope re-set from the plan (13 paths) and the baseline anchored.
- Cause read from the logs: 9 failures in `src/plugin-runner/` (3: `PHARGUS_RULE_TIMEOUT` after 2000 ms, and a permission-model child-flag case) and `src/release/publish-workflow.ac3.integration.test.ts` (6 timeouts at 5000 ms). None is under `src/otel`, none is in the plan's `## Files`, and none imports the changed files. The host load average was 118-130 during this iteration (`uptime`); the same release file run alone under that load still timed out 2 of 13 tests.
- No file was changed in this iteration: the red cannot be fixed within `## Files`, and the pinned AC tests are not edited. The targeted run over the 13 declared test files exited 0 (all 10 AC tests pass).
- Gate result: failed. `build-gate.mjs --mode full` exited 3 (test exit 1: 9 failed, 226 passed; lint, format:check, typecheck, build exit 0).

## Files written

- New: `src/otel/otlp-pending-items.ts`, `src/otel/otlp-drop-reporter.ts`.
- Rewritten: `src/otel/otlp-batch-queue.ts`.
- Edited: `src/otel/otlp-exporter-options.ts`, `src/otel/otlp-trace-exporter.ts`, `src/otel/otlp-exporter.ts`.
- Existing tests updated as the plan describes: `src/otel/otlp-bounds.integration.test.ts`, `src/otel/otel-trace-export.ac3.integration.test.ts`, `src/otel/otel-metrics-export.ac3.integration.test.ts`.
- Docs: `docs/THREAT-MODEL.md` (row F2), `FEATURES.md`, `README.md`, `CHANGELOG.md` (`### Fixed` under `## [Unreleased]`).
- Prettier realigned the F2 table in `docs/THREAT-MODEL.md`, so that diff is wider than the one sentence changed.
- The AC tests (`src/otel/otel-span-batching.ac*.test.ts`) were not edited.

## Deviations and notes for review

- `src/otel/otlp-pending-items.ts`: the ring starts at 16 slots and doubles up to `maxQueueSize` (head index and modulo), so a very large `maxQueueSize` allocates nothing up front.
- `flush()` and `close()` are bounded to the items pending at the call: the queue keeps a `due` count, and `flush()` resolves when that count is sent and no request is in flight, so it terminates under a continuous stream of pushes.
- `src/otel/otlp-bounds.integration.test.ts` second F-08 case ("default closeTimeoutMs"): the plan said it keeps its assertions, but the old `droppedBatches + failedBatches === 11` and `droppedBatches >= 9` depend on one request per export call. When the in-flight request's own timeout fires a few ms before the close deadline, the 10 pending items are now sent as one request and aborted at the deadline (`failedBatches` 2, `droppedBatches` 0). The assertion became the batching-independent item invariant `droppedItems + failedItems === 11` and `exportedItems === 0`. The elapsed-time bound is unchanged.
- `src/otel/otlp-drop-reporter.ts` exposes `dispose()` as the plan lists it; the queue does not call it, because drops after `close()` must still be reported and the timer is `unref()`ed.
- `queueCapacity` is validated only when supplied (an explicit `null` from untyped JavaScript now throws a `RangeError` instead of taking the default).

built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
