---
decision: STOP_GREEN_QUICK
iterations: 1
cap: 3
mode: quick
commit: ea7a3ba8cf41ebcadc6114161936439ccc38f258
date: 2026-10-07
---

# LOOP — span-export-wiring

- Stages: `/pharn-spec --quick --model-approve` (agent:opus) → `/pharn-plan` (agent:opus) → `/pharn-grill --quick`
  (inline, policy) → `/pharn-test --unattended` (agent:opus) → iteration 1: `/pharn-build` (agent:sonnet), scope check,
  `/pharn-verify` (inline, policy).
- Entry gates (lint, format:check, base:test, test, typecheck, build): all green at the base.
- Iteration 1: build gate pass; `check-quick-scope.mjs` exit 0 (no escaped path); verify `PASS`;
  `check-loop-fresh.mjs` `FRESH` (quick column); `check-loop.mjs` exit 0, `STOP_GREEN_QUICK`.
- Standing reds: none.
- Pointers: `GRILL.md`, `VERIFY.md` / `verify-report.json`, `BUILD.md`, `AC-TESTS.lock.json`. No `REGRESSION.md`
  (quick mode).

## Not checked in quick mode

- **regressions outside the feature** — no base comparison ran; the scope check did;
- **the plan interrogation** — `/pharn-grill --quick` ran its two floor stops only;
- **`RUN-REPORT.md`** — not rendered; `cost.json` is.

## Outcome

- commit: committed pharn-loop/span-export-wiring
- spec: approved by the model
- blocked: none
- ac-tests: test-first

## Handoff

### investigated

The agent already buffered finished HTTP spans (`span-buffer.ts`, `http-tracing.ts`) but nothing turned tracing on
from `auto-start.ts` or drained the buffer onto the NDJSON output; `TraceSpan` lacked `spanId` and `name`. The
collector's pipeline rejected any non-sample chunk at the aggregator, so span records had to be diverted before it.

### learned

Spans are flushed onto the NDJSON exporter after each sample tick and once on `beforeExit`, sharing the exporter's
drop-oldest queue with samples. A span router stage placed ahead of the window aggregator keeps window and alert
behaviour unchanged. The dashboard replays the span ring on connect and streams new spans as `span` SSE events behind
the existing token check.

### next_steps

Build the trace detail / waterfall view in the dashboard UI over the `span` SSE events (a later S4 slice). Consider
whether spans should have their own queue bound so a span burst cannot push out queued samples, and whether spans
finished after the last tick are lost on `process.exit()`.
