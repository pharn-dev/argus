# Argus — Feature List

**Everything in this document is in scope.** We build the full version — nothing
is deferred to "later." The only marker that remains is for items where the
_what_ is committed but the _how_ has an open design fork that must be answered
before that part is built.

Status legend:

- ✅ **In scope** — build it.
- ⚙️ **In scope, decide-the-how first** — committed feature, but an architecture
  decision must be made before implementing (see notes / `CLAUDE.md`).

---

## 1. Installation & integration

- ✅ One-line injection: `require('argus/agent')` / `import 'argus/agent'`.
- ✅ Preload via `node --require argus/agent app.js` (no source edit needed).
- ✅ Zero external dependencies in the agent (Node core only).
- ✅ Works the same locally and in production.
- ✅ Dual package: ESM + CJS.
- ✅ Config via env vars + `argus.config.{js,json}`.

## 2. Runtime metrics (the headline diagnostics)

- ✅ Event loop lag (delay/latency, percentiles over time windows).
- ✅ Memory pressure (heap usage, RSS, trend).
- ✅ GC events (frequency, pause durations) via a `--trace-gc` hook.
- ✅ Stream backpressure hotspots (where streams stall).
- ✅ Request tracing with automatic `traceId` per async context —
  **no user-code instrumentation**, powered by AsyncLocalStorage + async_hooks.

## 3. V8 / memory deep-dive

- ✅ `v8.getHeapSpaceStatistics()` exposure.
- ✅ On-demand heap snapshots.
- ✅ Heap-snapshot diffing (compare two snapshots to spot leaks).
- ✅ Allocation timeline / sampling profiler capture.
- ✅ Deoptimization detection via `--trace-deopt` parsing.
- ✅ Stack-trace symbolization (runs in a Worker Thread).

## 4. Data pipeline & export

- ✅ Agent exports data as an NDJSON stream with backpressure.
- ✅ Collector pipeline: raw metrics → aggregated time windows → alerts
  (Transform streams via `stream/promises` `pipeline()`).
- ✅ Integer-math aggregation (no float drift in counters).
- ✅ OpenTelemetry export of traces/metrics — behind an opt-in adapter so the
  agent core stays dependency-free. In scope, just architecturally isolated.

## 5. Dashboard

- ✅ Lightweight UI: vanilla JS, no framework, no bundler.
- ✅ Live updates over SSE (Server-Sent Events).
- ✅ Views for event loop lag, memory, GC, backpressure, traces.
- ✅ Trace detail / waterfall view per request.
- ✅ Time-range scrubbing of recent windows.
- ⚙️ Exposure/auth model when running in production — see `CLAUDE.md` decisions.

## 6. Custom diagnostic rules (plugin runner)

- ✅ User-supplied rules, e.g. "alert when function X takes > 50ms".
- ✅ Rules execute in `isolated-vm` with a **hard memory limit and timeout**.
- ✅ Node Permission Model constrains the agent.
- ✅ A small bundled rule library (common leak / latency patterns).

## 7. Analysis (Worker Threads)

- ✅ Heap-snapshot analysis off the monitored event loop.
- ✅ Worker pool for parallel profile processing.

## 8. Alerting

- ✅ Window-based alerts emitted from the pipeline.
- ✅ Alert thresholds configurable per metric.
- ✅ Alert sinks: stdout / file / webhook. Webhook uses Node core `http`/`fetch`
  only — the zero-dependency rule for the agent still holds.

## 9. Persistence

- ⚙️ In-memory ring buffer of recent windows is a given. Whether Argus also
  persists to disk (and in what format) is an open fork — see `CLAUDE.md`.

## 10. Examples (ship with the repo)

- ✅ `examples/express-app` — full instrumentation walkthrough.
- ✅ `examples/worker-pool` — Worker Threads scenario.

---

## Out of scope — by identity, not by timeline

These stay out even in the full build, because they contradict what Argus _is_
(lightweight, dependency-free, local-first). Cutting them is not deferral:

- A hosted/SaaS backend or a required external collector service.
- A heavy framework-based dashboard or a build step for the UI.
- Pulling any third-party APM/agent SDK into `@argus/agent`.
