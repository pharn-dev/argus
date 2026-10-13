---
decision: STOP_GREEN
iterations: 1
cap: 3
commit: d697b7a02f27d9c502cc141d40f1c77ffc7747ef
date: 2026-10-13
---

# LOOP — phargus-serve-cli

- Stages: `/pharn-spec --model-approve` (agent:opus), `/pharn-plan` (agent:opus), `/pharn-grill --floor-only`
  (inline, policy), entry gates (all six green at the base tree), `/pharn-test --unattended` (agent:opus,
  `READY test-first`), then iteration 1: `/pharn-build` (agent:sonnet, `done gate:pass`), `/pharn-regress` (inline,
  policy) and `/pharn-verify` (inline, policy).
- Iteration 1: regress `no-regressions`, verify `PASS`; `check-loop-fresh.mjs` FRESH; `check-loop.mjs` exit 0,
  `decision: STOP_GREEN`.
- Standing reds: none.
- Pointers: `GRILL.md`, `REGRESSION.md`, `VERIFY.md`, `BUILD.md` in this directory.

## Outcome

- commit: committed pharn-loop/phargus-serve-cli
- spec: approved by the model
- blocked: none
- ac-tests: test-first

## Handoff

### investigated

The collector and dashboard public APIs (`createNdjsonDecoder`, `createCollector`, `createDashboardServer`) already
covered everything the CLI needs, and the dashboard already refuses a non-loopback bind without a token, so no new
library surface was needed beyond re-exporting `isLoopbackHost`. Spawning the TypeScript CLI source directly was ruled
out by the plan: Node type stripping cannot resolve the `.js` relative imports, so the tests spawn the built ESM bin.

### learned

The CLI is ESM-only (`src/cli/**` excluded from the CJS build) and `bin` maps `phargus` to `dist/esm/cli/bin.js`; the
build asserts the shebang and sets mode 755. `PHARGUS_TOKEN` and `PHARGUS_DEBUG` share the agent's `PHARGUS_` env
prefix, so a user who exports them into the app's environment may get the agent's unknown-variable warning.

### next_steps

Exercise `check:install` against a packed tarball (its new `npx phargus --help` step was not run by the build), and
run the manual end-to-end check of `examples/express-app` piped into the built CLI with a curl to `/events`.
