# Argus — Architecture

This document is the "how it fits together" companion to `CLAUDE.md`. Read
`CLAUDE.md` first for rules and constraints.

---

## Mental model

Only the agent runs **inside** the process you want to observe. It samples, traces and writes
NDJSON to stdout or a file; it starts no server. Everything else is a library you wire to that
stream: the collector aggregates it, the dashboard serves the collector's output to a browser, and
the OpenTelemetry exporter and plugin runner read the collector's windows. You can run those in the
monitored process, but the shipped example (`examples/express-app`) runs them in a second process
that reads the app's stdout, so aggregation and serving never use the app's event loop.

```
┌──────────────── monitored Node.js process ─────────────────┐
│ user app code (no instrumentation required)                │
│                                                            │
│ argus/agent  (Node core only)                              │
│  ├─ HTTP tracing: diagnostics_channel + Server#emit wrap,  │
│  │  AsyncLocalStorage → traceId per incoming request       │
│  ├─ samplers: event loop delay, memory, heap spaces,       │
│  │  GC (PerformanceObserver), backpressure probe           │
│  ├─ library API: heap snapshot, allocation sampling,       │
│  │  --trace-deopt line parser                              │
│  └─ NDJSON exporter: sample lane + span lane, each bounded │
│     drop-oldest, one pipeline() to stdout or a file        │
└─────────────────────────────┬──────────────────────────────┘
                              │ NDJSON (sample lines carry dropped counters)
                              ▼
┌──────── collector / dashboard process (wired by the user) ─────────┐
│ argus/collector                                                    │
│  └─ pipeline(): spans → ring buffer │ samples → windows →          │
│     persistence (opt-in) → alerts → sinks (stdout/file/webhook)    │
│        │ subscribe()                                               │
│        ├─▶ argus/dashboard: HTTP server, static UI, SSE /events    │
│        ├─▶ argus/otel: OTLP/HTTP JSON metrics and traces (opt-in)  │
│        └─▶ argus/plugin-runner: rules over windows (opt-in)        │
│             └─ child process → isolated-vm (memory + time limit)   │
│                                                                    │
│ argus/analyzer (independent): Worker Thread pool for heap-snapshot │
│ summaries/diffs and stack-trace symbolization                      │
└───────────────────────────────┬────────────────────────────────────┘
                                │ SSE
                                ▼
                        browser dashboard
                     (vanilla JS, no bundler)
```

---

## Data flow, step by step

1. **Collection (agent).** `import 'argus/agent'` (or `--require`/`--import`) starts the agent once
   per process. Tracing subscribes to the `http.server.request.start` and
   `http.server.response.finish` diagnostics channels and wraps `Server.prototype.emit` for
   `node:http` and `node:https`, so each request's handler runs inside an `AsyncLocalStorage`
   context holding its trace id. A sampler controller ticks every `intervalMs`: event loop delay
   (`monitorEventLoopDelay`), `process.memoryUsage()`, `v8.getHeapSpaceStatistics()`, GC entries
   from a `PerformanceObserver`, and the backpressure probe, which wraps `write` on the
   `Writable`, `Duplex` and `http.OutgoingMessage` prototypes and records where writes return
   `false` and how long until `drain`. User code is never edited.
2. **Transport out of the agent.** Each tick drains the span buffer (1024 spans) into the span
   lane, then queues one sample line in the sample lane. Both lanes are bounded by `queueBound`
   and drop their oldest line when full; sample lines are always written before span lines, so
   spans cannot evict samples. One `stream/promises` `pipeline()` writes to stdout or a file
   without ever making the app wait. Every sample line carries cumulative
   `dropped: { samples, spans }` counters.
3. **Aggregation (collector).** `collector.consume()` takes parsed records (the caller turns NDJSON
   lines into objects) and runs a `pipeline()` of Transform streams: span records go to a ring
   buffer, samples become fixed time windows with integer math, windows go to an optional
   append-only file and to the alert evaluator, and alerts go to the sinks. Ring buffers bound
   windows, alerts and spans.
4. **Delivery (dashboard).** `createDashboardServer({ collector, host, port })` subscribes to the
   collector and serves the UI and an SSE endpoint. Each SSE client has its own bounded queue; a
   stalled client loses its oldest events, never the server's memory.
5. **Export and rules (optional).** `argus/otel` exporters subscribe to the collector and send
   windows as OTLP metrics and spans as OTLP traces. `argus/plugin-runner` runs user rules over a
   copy of recent windows in a sandboxed child process.
6. **Heavy analysis (analyzer).** Heap-snapshot summaries and diffs and stack-trace symbolization
   run in a Worker Thread pool with `resourceLimits`, a task timeout and input size caps, so the
   calling event loop is never blocked. The analyzer has no coupling to the other modules; you call
   it on files you choose.

---

## Module boundaries (who may import what)

- `src/agent` (`argus/agent`) — Node core only. **No imports from other modules, no
  third-party deps** (an ESLint rule enforces this).
- `src/collector` — consumes agent output; owns the stream pipeline.
- `src/analyzer` — Worker Threads only; pure CPU work, no app coupling.
- `src/dashboard` — SSE server + static UI; reads from collector output.
- `src/plugin-runner` — isolated-vm sandbox; reads aggregated data only.
- `src/otel` (`argus/otel`) — opt-in OTLP/HTTP JSON metrics and trace export; Node core only,
  reads collector output. The agent never imports it.

`async_hooks` is imported in exactly one file: `src/agent/context.ts`.

---

## Performance contract

- The agent's presence must add negligible overhead to the monitored process. This is measured,
  not assumed: `bench/overhead.mjs` runs agent-on versus agent-off on HTTP workloads, and
  `bench/soak.mjs` runs every module under load and fails on heap growth or leaked workers and
  child processes. A nightly workflow (`.github/workflows/nightly.yml`) runs both. The benchmark is
  informational; no overhead threshold gates a merge or a release yet.
- Backpressure is honored end to end: the agent drops and counts instead of waiting, and the
  dashboard drops per client instead of buffering without limit.

---

## Build & module setup

- One npm package (`argus`); the six modules live under `src/` and are exposed as subpath
  exports (`argus/agent`, `argus/collector`, `argus/analyzer`, `argus/dashboard`,
  `argus/plugin-runner`, `argus/otel`).
- `tsconfig.base.json` (strict) shared by two builds: `tsconfig.esm.json` →
  `dist/esm`, `tsconfig.cjs.json` → `dist/cjs` (`npm run build`).
- Every subpath ships dual ESM + CJS with a correct `exports` entry (separate types per format).
  Modules import each other by relative path; `package.json` has no `imports` field.
- `npm run check:exports` loads every subpath through `import` and `require`;
  `npm run check:package` checks the packed tarball's contents and that `engines.node` matches
  `.nvmrc`.
