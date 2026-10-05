# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Argus

> All-seeing runtime diagnostics for Node.js.

## Repo state & commands

**Pre-scaffold.** Only design docs exist; no `packages/` yet. The root
`package.json` (`"type": "commonjs"`, placeholder `test` script) and
`package-lock.json` are `npm init` leftovers. Replace them with the pnpm
workspace root during scaffolding and delete `package-lock.json`. Don't use npm here.

Intended workspace commands (from `CONTRIBUTING.md`; they don't exist until S0 lands):

```bash
pnpm install
pnpm -w build   # tsc --build across all project references
pnpm -w test
pnpm -w lint
```

No test runner is chosen yet, so there's no single-test command. Add one here when one is picked.

## Companion docs

- `ARCHITECTURE.md`: data flow, in-process diagram, **who may import what**.
- `FEATURES.md`: full feature scope (everything is in scope; ⚙️ = design fork).
- `ROADMAP.md`: build order S0–S8 (dependency order, not scope cuts). Each
  step must leave `main` compiling and runnable.
- `CONTRIBUTING.md`: the rules PRs are checked against.

Argus is a runtime diagnostics agent for Node.js processes. You drop in a single
`require('argus/agent')` (or `import 'argus/agent'`) and get a dashboard with
event loop lag, memory pressure, stream backpressure hotspots, GC events, and
request tracing — **with zero external dependencies**, no Datadog, no collector
service. Works locally and in production.

This is an open-source product, treated as one from day one — not a learning toy.

---

## Why this exists (don't lose this framing)

The market gap is real and it drives the design:

- `clinic.js` is heavy and one-shot (capture → analyze offline).
- OpenTelemetry is powerful but complex to set up for a quick look.
- Datadog and friends cost money and require an account.

Argus is the thing you reach for at 2am when something is broken: one line,
runs in-process, works locally and in prod. **The "zero external dependencies in
the agent" constraint is the killer adoption feature — never compromise it.**

---

## Architecture

Monorepo, **pnpm workspaces**. Five packages under `@argus/*`:

```
argus/
├── packages/
│   ├── agent/          # @argus/agent — core, injected into the monitored process
│   ├── collector/      # @argus/collector — metric aggregation, stream pipeline
│   ├── analyzer/       # @argus/analyzer — Worker Threads, heap analysis
│   ├── dashboard/      # @argus/dashboard — lightweight UI (SSE + vanilla JS)
│   └── plugin-runner/  # @argus/plugin-runner — isolated-vm sandbox for user rules
├── examples/
│   ├── express-app/    # example with full instrumentation
│   └── worker-pool/    # example with Worker Threads
```

### Package responsibilities

- **agent** — runs inside the monitored process. Collects raw signals (event loop
  lag, memory, GC, stream backpressure, traces). Must stay dependency-free and add
  near-zero overhead. This is the package users install.
- **collector** — aggregates raw metrics. Owns the stream pipeline: raw metrics →
  aggregated time windows → alerts (Transform streams).
- **analyzer** — CPU-heavy work (heap snapshot analysis, stack-trace
  symbolization) runs here in Worker Threads so the monitored process's event loop
  is never blocked. Worker pool for parallel profile processing.
- **dashboard** — lightweight UI. Vanilla JS, no framework, no bundler. Receives
  data over SSE (Server-Sent Events).
- **plugin-runner** — optional. Users can write custom diagnostic rules (e.g.
  "alert when function X takes > 50ms"). Rules execute inside `isolated-vm` with a
  hard memory limit and timeout.

### Dependency boundaries

- `@argus/agent` imports **Node core only**: no third-party deps *and no workspace
  deps*. Everything else depends on the agent, never the other way round.
- `@argus/collector` consumes agent output. `@argus/dashboard` reads collector
  output. `@argus/plugin-runner` reads aggregated data only.
- `@argus/analyzer` is pure CPU work in Worker Threads with no app coupling.
- OTel export lives in an opt-in adapter outside the agent core.

---

## How the core Node.js concepts map to features

These aren't bolted on — each is load-bearing in the design:

- **AsyncLocalStorage + async_hooks** → core tracing mechanism. Every async
  context automatically gets a `traceId` with **no instrumentation of user code**.
  The agent uses `async_hooks` to track context propagation across the call stack.
- **Streams + backpressure** → the agent exports data as an NDJSON stream with
  backpressure. The dashboard consumes it over SSE. Transform streams turn raw
  metrics into aggregated windows and then alerts.
- **Worker Threads / CPU parallelism** → heap-snapshot analysis and stack-trace
  symbolization happen in a Worker Thread, never on the monitored event loop. A
  worker pool processes profiles in parallel.
- **Security / sandboxing** → the plugin runner executes user-supplied rules in
  `isolated-vm` with a hard memory limit and timeout. The Node Permission Model
  (`--permission`, stable since Node 22.13; older 22.x used
  `--experimental-permission`) constrains what the agent itself may do.
- **V8 performance / memory** → exposes `v8.getHeapSpaceStatistics()`, surfaces
  `--trace-gc` events via a custom hook, supports on-demand heap snapshots, and
  detects deoptimizations by parsing `--trace-deopt` output.

---

## Technical constraints (hard rules)

- **Zero external dependencies in `@argus/agent`.** This is the product's whole
  point. Anything the agent needs comes from Node core. No exceptions.
- **Dual package: ESM + CJS.** Correct `exports` field in every package.
- Use the `imports` field for internal aliases.
- **TypeScript strict mode throughout.** No `any` without an explicit comment
  explaining why.
- Dashboard UI: vanilla JS, no framework, no bundler. Keep it tiny.
- Agent overhead on the monitored process must be negligible — benchmark it,
  don't assume it.

---

## Coding conventions

- `async_hooks` usage is isolated to `@argus/agent/src/context.ts`. **Nowhere else
  imports from `async_hooks` directly.**
- All Worker Thread files live in a `*/src/workers/` subdirectory. Never inline,
  `eval`-based workers.
- Stream pipelines always use `stream/promises` `pipeline()` — **never `.pipe()`**.
- Error handling: every stream, every worker, every plugin execution is wrapped
  with explicit error handling. **No silent failures, no swallowed rejections.**
- Metrics aggregation uses integer math wherever possible — avoid float drift in
  counters.

---

## Open-source-from-day-one

- Conventional commits + `semantic-release`.
- `CONTRIBUTING.md`, labeled `good-first-issue`s.
- CI/CD via GitHub Actions (test + build + release).
- OpenTelemetry instrumentation is a natural integration target — Argus emitting
  OTel traces/metrics turns it into a credible observability story (and is itself
  a portfolio signal). Treat OTel export as a first-class optional output, not the
  core (the core stays dependency-free).
- Launch plan: technical blog content + a "Show HN" post.

---

## First task for a fresh repo

> We are building Argus from scratch. Start by scaffolding the monorepo: pnpm
> workspaces root, `tsconfig.base.json` with strict mode, a shared eslint config,
> and the skeleton of all 5 packages (`agent`, `collector`, `analyzer`,
> `dashboard`, `plugin-runner`) with correct `package.json` `exports` fields
> (dual CJS+ESM), correct inter-package dependencies, and TypeScript project
> references. **No implementation yet — just the structure that compiles cleanly
> with `tsc --build`.**

---

## Architecture decisions (full build — locked, override if you disagree)

We're building the full version, so these forks are decided up front rather than
discovered mid-implementation. These are recommended defaults; flip any of them
deliberately, but don't leave them implicit.

- **Minimum Node.js version: Node 22 LTS as the floor** (24 fine too). This is
  the lever for the Permission Model and `node:` imports — confirm the exact
  permission flag name/stability for the version you pin before relying on it in
  the plugin runner.
- **Persistence: in-memory ring buffer always, plus opt-in disk persistence** of
  recent windows/snapshots (append-only file, no external DB — keeps the
  dependency-free, local-first identity).
- **Dashboard exposure in production: token-gated by default.** The SSE endpoint
  and UI require a token when not bound to localhost; never exposed unauthenticated
  in prod.
- **Pin the toolchain:** `packageManager` field + `.nvmrc` matching the Node floor.