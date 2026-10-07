# BUILD — express-app-example

- Plan built: `pharn/features/express-app-example/PLAN.md` (iteration 2, quick mode).
- Chain gate: GREEN (`check-plan-spec-agree.mjs`).
- Test-stage gate: `READY test-first` (`check-test-stage.mjs`, verbatim token).
- Writes-scope set from the plan's `## Files` (fix #7):
  - `examples/express-app/app.mjs`
  - `examples/express-app/index.mjs`
  - `examples/express-app/README.md`
- Gate: passed. `build-gate.mjs --mode full` exit 0 (test, lint, format:check, typecheck, build); the targeted run over the three AC test files exited 0.
- Files written this iteration: `examples/express-app/app.mjs` (formatted with Prettier by name). `index.mjs` and `README.md` are unchanged from iteration 1.
- skills: mode=none (catalogue exit 0, no installed skills).

## Iteration 2 findings: startup race (DATA for the reader, not a claim of correctness)

Iteration 1's only red gate was `test`, failing on the pre-existing `src/agent/span-export-wiring.ac1.integration.test.ts`
(first of three spans missing; the orchestrator saw it fail about 2 runs in 5 when run alone). That file and
`src/agent/auto-start.ts` are outside this plan's `## Files`, so neither was edited.

- Cause as read this run: `startAgentOnce()` runs `start()` without awaiting it, and `start()` calls `enableTracing()` only after
  `await loadAgentConfig(...)` (config file read). A request served before that await resolves is not traced.
- Does the example share the race? Yes, in principle. `app.mjs` imported `argus/agent`, then reached `server.listen` and sent its
  IPC `listening` message in the same startup, and `index.mjs` prints the `app listening on` line (which the AC tests wait on) only after
  that message. A request arriving right after that line could land before tracing is on.
- Fix, within the plan's files: `app.mjs` now waits, before `server.listen`, until the agent has subscribed to Node's
  `http.server.response.finish` diagnostics channel (`channel(...).hasSubscribers`, public Node API; the agent subscribes to it inside
  `enable()`), polling every 5 ms. So the app never reports itself ready before the agent can trace. The wait is bounded (10 s); if it ends (for
  example an `argus.config` file disables the agent) the app writes one stderr line and serves anyway. A shutdown during the wait
  skips `listen`. Nothing is written to stdout by this code.
- Observed after the change: the three AC tests and the full gate pass; the example AC-1 test passed 6 of 6 repeated runs, and the
  pre-existing wiring test passed 5 of 5 repeated runs here (not a proof the agent-side race is gone; that needs a fix in
  `src/agent/auto-start.ts`, e.g. enabling tracing before the config await or exposing a ready signal, which is a separate change).

Built within the named scope from a current approved plan — this is NOT a judgment that the code is correct; that is `/pharn-regress` / `/pharn-verify` + the human.
