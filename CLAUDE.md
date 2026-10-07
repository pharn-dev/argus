# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Argus

> All-seeing runtime diagnostics for Node.js.

## Repo state & commands

**Package manager: npm.** Argus is one normal npm package (a single root `package.json`).
Use npm only; don't add another package manager or its lockfile. Commit `package-lock.json`.

Commands (run from the repo root):

```bash
npm install
npm run build           # dual build into dist/: ESM (dist/esm) + CJS (dist/cjs)
npm run check:exports   # after build: every `exports` subpath loads via import and require
npm run typecheck       # tsc --noEmit over src/ and the repo's own scripts and configs
npm test
npm run lint
npm run format:check
```

Run one module's tests with `npx vitest run src/<module>`, or one file with `npx vitest run <path>`.

**Every file you write must pass `npm run format:check`.** Run `npx prettier --write <file>` on each
source or test file you create or edit, before running any gate. CI fails on unformatted files.

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

One npm package (`argus`) with six modules under `src/`, each exposed as a subpath
export (`argus/agent`, `argus/collector`, …):

```
argus/
├── src/
│   ├── agent/          # argus/agent — core, injected into the monitored process
│   ├── collector/      # argus/collector — metric aggregation, stream pipeline
│   ├── analyzer/       # argus/analyzer — Worker Threads, heap analysis
│   ├── dashboard/      # argus/dashboard — lightweight UI (SSE + vanilla JS)
│   ├── plugin-runner/  # argus/plugin-runner — isolated-vm sandbox for user rules
│   └── otel/           # argus/otel — opt-in OTLP/HTTP JSON export (Node core only)
├── scripts/            # build (dual ESM + CJS) and exports smoke test
├── examples/
│   ├── express-app/    # example with full instrumentation
│   └── worker-pool/    # example with Worker Threads
```

### Module responsibilities

- **agent** — runs inside the monitored process. Collects raw signals (event loop
  lag, memory, GC, stream backpressure, traces). Must stay dependency-free and add
  near-zero overhead. This is the module users install.
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
- **otel** — optional. OTLP/HTTP JSON export of collector windows (metrics) and
  spans (traces), Node core only, outside the agent.

### Dependency boundaries

- `src/agent` imports **Node core only** (`node:` builtins) and its own files: no
  third-party deps _and no imports from the other modules_ (an ESLint rule enforces
  this). Everything else depends on the agent, never the other way round. The root
  `package.json` keeps no runtime `dependencies`; heavier deps (e.g. `isolated-vm`)
  are optional peer dependencies used only by the module that needs them.
- `src/collector` consumes agent output. `src/dashboard` reads collector
  output. `src/plugin-runner` reads aggregated data only.
- `src/analyzer` is pure CPU work in Worker Threads with no app coupling.
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

- **Zero external dependencies in `src/agent`.** This is the product's whole
  point. Anything the agent needs comes from Node core. No exceptions.
- **Dual package: ESM + CJS.** Every module has a correct `exports` subpath with
  `import` and `require` conditions, each with its own types.
- Use the `imports` field for internal aliases.
- **TypeScript strict mode throughout.** No `any` without an explicit comment
  explaining why.
- Dashboard UI: vanilla JS, no framework, no bundler. Keep it tiny.
- Agent overhead on the monitored process must be negligible — benchmark it,
  don't assume it.

---

## Coding conventions

- `async_hooks` usage is isolated to `src/agent/context.ts`. **Nowhere else
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

- Conventional commits; releases are manual (version bump PR → GitHub Release → CI publishes to
  npm with provenance). `CHANGELOG.md` is kept by hand. See `docs/RELEASING.md`.
- `CONTRIBUTING.md`, labeled `good-first-issue`s.
- CI/CD via GitHub Actions (format, lint, typecheck, test, build, action pins, CodeQL, gitleaks;
  release on GitHub Release).
- OpenTelemetry instrumentation is a natural integration target — Argus emitting
  OTel traces/metrics turns it into a credible observability story (and is itself
  a portfolio signal). Treat OTel export as a first-class optional output, not the
  core (the core stays dependency-free).
- Launch plan: technical blog content + a "Show HN" post.

---

## First task for a fresh repo

> We are building Argus from scratch. Start by scaffolding the package: a single
> npm `package.json`, `tsconfig.base.json` with strict mode, a shared eslint
> config, and the skeleton of the 5 modules (`agent`, `collector`, `analyzer`,
> `dashboard`, `plugin-runner`) under `src/` with correct `package.json`
> `exports` subpaths (dual CJS+ESM). **No implementation yet — just the structure
> that compiles cleanly with `npm run build`.**

---

## Architecture decisions (full build — locked, override if you disagree)

We're building the full version, so these forks are decided up front rather than
discovered mid-implementation. These are recommended defaults; flip any of them
deliberately, but don't leave them implicit.

- **Minimum Node.js version: Node 22.18.0 as the floor** (`engines.node` `>=22.18.0`,
  `.nvmrc` `22.18.0`; 24 fine too). 22.18 is the lowest version the full test suite
  passes on (it loads `.ts` workers through type stripping). This is
  the lever for the Permission Model and `node:` imports — confirm the exact
  permission flag name/stability for the version you pin before relying on it in
  the plugin runner.
- **Persistence: in-memory ring buffer always, plus opt-in disk persistence** of
  recent windows/snapshots (append-only file, no external DB — keeps the
  dependency-free, local-first identity).
- **Dashboard exposure in production: token-gated by default.** The SSE endpoint
  and UI require a token when not bound to localhost; never exposed unauthenticated
  in prod.
- **Pin the toolchain:** `.nvmrc` matching the Node floor, plus `engines` (`node` and `npm`) in the
  root `package.json`. CI uses `npm ci` against the committed `package-lock.json`.
