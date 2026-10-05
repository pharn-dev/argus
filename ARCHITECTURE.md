# Argus — Architecture

This document is the "how it fits together" companion to `CLAUDE.md`. Read
`CLAUDE.md` first for rules and constraints.

---

## Mental model

Argus runs **inside** the process you want to observe. There is no separate
collector service to deploy. A metric is born in the monitored process, gets
aggregated in-process, and is streamed out to a dashboard that you open in a
browser.

```
┌───────────────────────── monitored Node.js process ─────────────────────────┐
│                                                                              │
│  user app code                                                               │
│       │  (no instrumentation required)                                       │
│       ▼                                                                       │
│  @argus/agent                                                                │
│   ├─ async_hooks + AsyncLocalStorage  → traceId per async context            │
│   ├─ event loop lag / memory / GC hooks                                      │
│   ├─ stream backpressure probes                                             │
│   └─ v8 stats, heap snapshot trigger, --trace-deopt parse                    │
│       │  raw signals                                                          │
│       ▼                                                                       │
│  @argus/collector                                                            │
│   └─ stream pipeline: raw → aggregated windows → alerts (Transform streams)  │
│       │                          │                                            │
│       │ heavy work               │ NDJSON stream (backpressured)             │
│       ▼                          ▼                                            │
│  @argus/analyzer            @argus/dashboard (server side)                    │
│   └─ Worker Thread pool:     └─ serves UI + SSE endpoint                      │
│      heap analysis,                                                          │
│      stack symbolization                                                     │
│                                                                              │
│  @argus/plugin-runner (optional)                                             │
│   └─ user rules in isolated-vm (mem limit + timeout)                         │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │ SSE
                                    ▼
                            browser dashboard
                         (vanilla JS, no bundler)
```

---

## Data flow, step by step

1. **Collection (agent).** The agent installs core hooks (event loop monitor, GC
   trace hook, memory sampling, stream backpressure probes) and an
   `async_hooks`/ALS layer that tags every async context with a `traceId`. User
   code is never edited.
2. **Transport out of the agent.** Raw signals leave as an NDJSON stream. This
   stream is backpressured — if the consumer is slow, the agent must not buffer
   unboundedly or add latency to the app.
3. **Aggregation (collector).** A `pipeline()` of Transform streams turns raw
   samples into fixed time windows, then derives alerts from those windows. All
   counter math is integer-based.
4. **Heavy analysis (analyzer).** Anything CPU-bound — heap snapshot parsing,
   stack-trace symbolization — is dispatched to a Worker Thread pool so the
   monitored event loop is never blocked.
5. **Delivery (dashboard).** The dashboard server exposes an SSE endpoint; the
   browser UI subscribes and renders live. No framework, no build step.
6. **Custom rules (plugin-runner, optional).** User-defined diagnostic rules run
   in `isolated-vm` with a hard memory cap and timeout, fed from the aggregated
   stream.

---

## Package boundaries (who may import what)

- `@argus/agent` — Node core only. **No workspace deps, no third-party deps.**
- `@argus/collector` — consumes agent output; owns the stream pipeline.
- `@argus/analyzer` — Worker Threads only; pure CPU work, no app coupling.
- `@argus/dashboard` — SSE server + static UI; reads from collector output.
- `@argus/plugin-runner` — isolated-vm sandbox; reads aggregated data only.

`async_hooks` is imported in exactly one file: `@argus/agent/src/context.ts`.

---

## Non-negotiable performance contract

- The agent's presence must add negligible overhead to the monitored process.
  Treat this as a measurable requirement, not a hope — benchmark agent-on vs
  agent-off in the example apps.
- Backpressure must be honored end to end; a slow dashboard must never slow the
  monitored app.

---

## Build & module setup

- pnpm workspaces monorepo.
- `tsconfig.base.json` (strict) + TypeScript project references; `tsc --build`.
- Every package ships dual ESM + CJS with a correct `exports` field; internal
  aliases use the `imports` field.
