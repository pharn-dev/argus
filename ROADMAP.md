# Argus — Build Order

We build the **full** product. Nothing here is optional and nothing is deferred
to a "later" phase. This document is **build order, not scope-cutting** — the
sequence is dependency order so `main` always compiles and runs. The agent must
exist before the collector has anything to aggregate; the collector before the
dashboard has anything to show. That's all the ordering means.

Calendar is yours to set; the ordering is the point.

**Status:** S0 to S7 are implemented on `main`. S8 (first npm release and launch) is on hold.
Where the built code differs from a step's wording below:

- S1: GC events come from a `PerformanceObserver`, not a `--trace-gc` hook.
- S3: the dashboard has no backpressure view and no time-range scrubbing yet (see `FEATURES.md`).
- S5: `--trace-deopt` support is a parser; nothing captures that output.

---

## S0 — Scaffold

- Single npm package, `tsconfig.base.json` (strict), shared eslint config.
- Skeleton of the 5 modules under `src/` (a sixth, `otel`, came with S7) with correct `exports` subpaths (dual
  CJS+ESM) and an import-boundary lint rule for the agent.
- CI: GitHub Actions running build + typecheck + lint + test on PRs.
- Release process in place (`docs/RELEASING.md`, `publish.yml`); publishing goes live at S8.
- Outcome: a clean single package that builds with `npm run build`.

## S1 — Agent core: the one-liner

- `require('argus/agent')` + `--require` preload, zero third-party deps.
- Event loop lag + memory sampling.
- GC hook (`--trace-gc`) and stream backpressure probes.
- NDJSON export stream with proper backpressure.
- Config loading (env + `argus.config`).
- Outcome: attach to a script, see all raw runtime signals flowing out.

## S2 — Collector pipeline

- Transform-stream pipeline: raw → aggregated windows → alerts.
- Integer-math aggregation; in-memory ring buffer of recent windows.
- Alert thresholds + sinks (stdout / file / webhook via Node core only).
- Outcome: stable aggregated windows + working alerts.

## S3 — Dashboard

- SSE server + vanilla-JS UI.
- All live views: event loop lag, memory, GC, backpressure.
- Time-range scrubbing of recent windows.
- `examples/express-app` wired end to end.
- Outcome: open a browser, watch a real app's vitals live.

## S4 — Tracing

- async_hooks + ALS traceId propagation (no user instrumentation).
- Trace detail / waterfall view in the dashboard.
- Outcome: per-request visibility — the core differentiator.

## S5 — V8 / memory depth

- Heap snapshots on-demand + analysis in the analyzer Worker Thread pool.
- Heap-snapshot diffing, allocation timeline / sampling profiler.
- `v8.getHeapSpaceStatistics()`, `--trace-deopt` parsing, stack symbolization.
- `examples/worker-pool` wired up.
- Outcome: full runtime depth, not just app-level metrics.

## S6 — Plugin runner

- User rules in `isolated-vm` with memory limit + timeout.
- Bundled rule library (common leak / latency patterns).
- Node Permission Model applied to the agent.
- Outcome: extensibility + the security story.

## S7 — OpenTelemetry adapter

- Opt-in OTel export of traces/metrics, isolated so the agent core stays dep-free.
- Outcome: drops into existing observability stacks.

## S8 — Launch

- First npm release, through the manual process in `docs/RELEASING.md`.
- `README` with a GIF/asciinema of one-liner → dashboard.
- `CONTRIBUTING.md`, labeled `good-first-issue`s.
- Technical blog post + "Show HN".
- Outcome: public v0.x launch.

---

## Guardrails while building

- The zero-dependency rule for `src/agent` is never broken to move faster.
- Every step ends in a compiling, runnable state — no long-lived broken main.
- The architecture forks in `CLAUDE.md` (min Node version, dashboard auth in
  prod, disk persistence) are decided up front, since we're building the full
  version — not discovered mid-step.
