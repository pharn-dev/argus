# Argus — Build Order

We build the **full** product. Nothing here is optional and nothing is deferred
to a "later" phase. This document is **build order, not scope-cutting** — the
sequence is dependency order so `main` always compiles and runs. The agent must
exist before the collector has anything to aggregate; the collector before the
dashboard has anything to show. That's all the ordering means.

Calendar is yours to set; the ordering is the point.

---

## S0 — Scaffold

- pnpm workspaces, `tsconfig.base.json` (strict), shared eslint config.
- Skeleton of all 5 packages with correct `exports` (dual CJS+ESM), inter-package
  deps, and TS project references.
- CI: GitHub Actions running `tsc --build` + lint on PRs.
- semantic-release wired (publishing comes online later, config lands now).
- Outcome: clean monorepo that compiles with `tsc --build`.

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

- semantic-release publishing to npm goes live.
- `README` with a GIF/asciinema of one-liner → dashboard.
- `CONTRIBUTING.md`, labeled `good-first-issue`s.
- Technical blog post + "Show HN".
- Outcome: public v0.x launch.

---

## Guardrails while building

- The zero-dependency rule for `@argus/agent` is never broken to move faster.
- Every step ends in a compiling, runnable state — no long-lived broken main.
- The architecture forks in `CLAUDE.md` (min Node version, dashboard auth in
  prod, disk persistence) are decided up front, since we're building the full
  version — not discovered mid-step.
