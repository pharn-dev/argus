# Argus — Feature List

**Everything in this document is in scope.** We build the full version; nothing is deferred to
"later". The markers record what the code on `main` does today, so a reader can tell a built
feature from a planned one.

Status legend:

- ✅ **Implemented** — in the code, with tests.
- 🟡 **Partly implemented** — the note says what is missing.
- ⬜ **Not built yet** — in scope, no code yet.

---

## 1. Installation & integration

- ✅ One-line injection: `require('argus/agent')` / `import 'argus/agent'`.
- ✅ Preload via `node --require argus/agent app.js` or `node --import argus/agent app.mjs` (no
  source edit needed).
- ✅ Zero external dependencies in the agent (Node core only; enforced by ESLint).
- ✅ Dual package: ESM + CJS, six subpath exports.
- ✅ Config via env vars (`ARGUS_OUTPUT`, `ARGUS_INTERVAL_MS`, `ARGUS_QUEUE_BOUND`,
  `ARGUS_ENABLED`) + `argus.config.{js,json}`. Unknown `ARGUS_*` variables warn and are ignored.
- 🟡 Works the same locally and in production. The agent does; the dashboard needs a collector
  process wired by you (see `examples/express-app`), and the default output is the app's stdout.
- ⬜ Published to npm. On hold (S8); build from source for now.

## 2. Runtime metrics (the headline diagnostics)

- ✅ Event loop lag (min, max, mean, p50, p99 per interval; aggregated per window).
- ✅ Memory pressure (samples carry heap used/total, RSS, external and array buffers; windows keep
  the last and max heap used and RSS).
- ✅ GC events (count, total and max pause, by kind) from `PerformanceObserver` `gc` entries. There
  is no `--trace-gc` text hook; the observer gives the same counts without parsing.
- ✅ Stream backpressure hotspots (where writes stall, by call site) for `Writable` subclasses,
  `fs.WriteStream`, `Duplex`, `Transform`, `PassThrough`, `net.Socket`, `tls.TLSSocket`,
  `http.ServerResponse` and `http.ClientRequest`.
- 🟡 Request tracing with an automatic `traceId` — **no user-code instrumentation**, powered by
  AsyncLocalStorage. Covers incoming requests to `node:http` and `node:https` servers, honouring
  an incoming W3C `traceparent`. Outgoing requests and other entry points get no span.
- ✅ Loss accounting: bounded output lanes with `dropped: { samples, spans }` on every sample line.

## 3. V8 / memory deep-dive

- ✅ `v8.getHeapSpaceStatistics()` exposure (in every sample).
- ✅ On-demand heap snapshots (`takeHeapSnapshot`, library API).
- ✅ Heap-snapshot summaries and diffing in the analyzer worker pool, with an input size cap.
- ✅ Allocation sampling profiler capture (`sampleAllocations`, library API).
- 🟡 Deoptimization detection: a bounded parser for `node --trace-deopt` output
  (`createDeoptParser`). Nothing in Argus starts or captures that output; you feed the parser lines.
- ✅ Stack-trace symbolization in a Worker Thread, with optional directory confinement (`roots`).

## 4. Data pipeline & export

- ✅ Agent exports data as an NDJSON stream with backpressure (stdout or a file; drop-oldest).
- ✅ Collector pipeline: raw samples → aggregated time windows → alerts (Transform streams via
  `stream/promises` `pipeline()`).
- ✅ Integer-math aggregation (no float drift in counters).
- ✅ OpenTelemetry export of windows (metrics) and spans (traces) as OTLP/HTTP JSON, in
  `argus/otel`, outside the agent core. Bounded queue, timeouts, no redirects, bounded `close()`.

## 5. Dashboard

- ✅ Lightweight UI: vanilla JS, no framework, no bundler.
- ✅ Live updates over SSE (Server-Sent Events), bounded per client.
- 🟡 Views for event loop lag, memory, GC, alerts and traces. There is no backpressure view yet;
  backpressure is in the windows on `/events`.
- ✅ Trace detail / waterfall view of recent requests.
- ⬜ Time-range scrubbing of recent windows. The page shows the latest window only.
- ✅ Exposure/auth model: loopback without a token, any other bind requires one; `Host`/`Origin`
  allowlist (`allowedHosts`); `?token=` exchanged once for an `HttpOnly`, `SameSite=Strict` cookie;
  `Authorization: Bearer` for API clients.

## 6. Custom diagnostic rules (plugin runner)

- ✅ User-supplied rules, e.g. "alert when the event loop lag goes over 50 ms" (rules run over
  aggregated windows).
- ✅ Rules execute in `isolated-vm` in a child process with a **hard memory limit and timeout**,
  and capped results (`maxFindings`, `maxResultBytes`).
- ✅ A small bundled rule library (event loop lag, GC pause share, heap growth).
- 🟡 Node Permission Model. The agent runs under `--permission` with file system grants only, and
  the sandbox child inherits the host's permission flags. Argus does not turn the permission model
  on for you; you start Node with it. See `docs/PERMISSIONS.md`.

## 7. Analysis (Worker Threads)

- ✅ Heap-snapshot analysis off the monitored event loop, streamed, with `resourceLimits` on every
  worker.
- ✅ Worker pool for parallel profile processing (bounded queue, task timeout, crashed workers
  replaced).

## 8. Alerting

- ✅ Window-based alerts emitted from the pipeline.
- ✅ Alert thresholds configurable per metric (`>` or `>=`, optionally for N consecutive windows).
- ✅ Alert sinks: stdout / file / webhook. Webhook uses Node core `fetch` only, never follows
  redirects, and has a bounded `close()`.

## 9. Persistence

- ✅ In-memory ring buffers of recent windows, alerts and spans.
- ✅ Opt-in disk persistence of recent windows: an append-only NDJSON file with a byte cap
  (compacted to the newest windows), restored on start, created with mode `0600`.

## 10. Examples (ship with the repo)

- ✅ `examples/express-app` — agent in the app, collector and dashboard in a second process.
- ✅ `examples/worker-pool` — Worker Threads, a heap snapshot and analysis on the analyzer pool.

## 11. Measurement

- ✅ `bench/overhead.mjs` (agent-on versus agent-off) and `bench/soak.mjs` (leak checks under
  load), run nightly. Informational: no overhead gate yet.

---

## Out of scope — by identity, not by timeline

These stay out even in the full build, because they contradict what Argus _is_
(lightweight, dependency-free, local-first). Cutting them is not deferral:

- A hosted/SaaS backend or a required external collector service.
- A heavy framework-based dashboard or a build step for the UI.
- Pulling any third-party APM/agent SDK into the agent (`src/agent`).
