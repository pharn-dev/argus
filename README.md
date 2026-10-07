# Argus

> All-seeing runtime diagnostics for Node.js.

Argus is a runtime diagnostics agent for Node.js. Drop in one line and get a live dashboard with
event loop lag, memory pressure, GC events, stream backpressure hotspots and request tracing —
**with zero external dependencies in the agent**. No Datadog account, no collector service, no
offline capture-and-analyze step. It runs in-process and works the same locally and in production.

> **Status: pre-release, under active construction.** The design is settled and the repository is
> being scaffolded (see [`ROADMAP.md`](./ROADMAP.md)). Nothing is published to npm yet, and the
> usage below is the target interface, not something you can install today.

## Why Argus

- [clinic.js](https://clinicjs.org/) is heavy and one-shot: capture, then analyze offline.
- OpenTelemetry is powerful but takes real setup for a quick look.
- Hosted APMs cost money and require an account.

Argus is what you reach for at 2am when something is broken: one line, in-process, no account.
The agent's zero-dependency constraint is the adoption feature, and it is never compromised.

## Target usage

```js
// CommonJS
require('argus/agent');

// ESM
import 'argus/agent';
```

Or with no source edit at all:

```bash
node --require argus/agent app.js
```

The package name and install command will be documented here once the first release is published.

## What you get

- **Runtime metrics** — event loop lag percentiles, heap and RSS trends, GC frequency and pauses,
  stream backpressure hotspots.
- **Request tracing** — an automatic `traceId` per async context, powered by `AsyncLocalStorage`,
  with **no instrumentation of your code**.
- **V8 and memory depth** — heap space statistics, on-demand heap snapshots and diffing, allocation
  sampling, deoptimization detection. Heavy analysis runs in Worker Threads, never on your event
  loop.
- **A tiny dashboard** — vanilla JS, no framework, no bundler, live over Server-Sent Events.
- **Alerts and custom rules** — window-based alerts, plus user rules executed in an `isolated-vm`
  sandbox with a hard memory limit and timeout.
- **Optional OpenTelemetry export** — an opt-in adapter outside the agent core.

The full scope lives in [`FEATURES.md`](./FEATURES.md).

## How it fits together

Argus runs inside the process you want to observe. A metric is born in the monitored process, is
aggregated there, and is streamed out as backpressured NDJSON to a dashboard you open in a browser.
A slow dashboard never slows your app.

| Module (`src/…`) | Import as             | Role                                                              |
| ---------------- | --------------------- | ----------------------------------------------------------------- |
| `agent`          | `argus/agent`         | Collects raw signals inside your process. Node core only.         |
| `collector`      | `argus/collector`     | Aggregates raw metrics into windows and alerts (stream pipeline). |
| `analyzer`       | `argus/analyzer`      | Heap-snapshot and stack-trace analysis in Worker Threads.         |
| `dashboard`      | `argus/dashboard`     | Lightweight UI and SSE server.                                    |
| `plugin-runner`  | `argus/plugin-runner` | Optional sandbox for user-written diagnostic rules.               |
| `otel`           | `argus/otel`          | Opt-in OTLP/HTTP JSON metrics and trace export. Node core only.   |

Argus is one npm package: the modules are subpath exports, shipped as both ESM and CommonJS.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the data flow and module boundaries.

## Safety and honesty

- **Overhead is a measured contract, not a hope.** Changes in the agent's hot path ship with an
  agent-on versus agent-off benchmark.
- **The dashboard is token-gated by default** whenever it is not bound to localhost.
- **The agent runs under the Node permission model.** The minimal `--permission` flag set is in
  [`docs/PERMISSIONS.md`](./docs/PERMISSIONS.md).
- **Heap snapshots and traces can contain sensitive data.** Treat them accordingly; see
  [`SECURITY.md`](./SECURITY.md), [`docs/THREAT-MODEL.md`](./docs/THREAT-MODEL.md) and
  [`docs/LIMITS.md`](./docs/LIMITS.md).

Requires **Node.js 22 or newer** (see [`.nvmrc`](./.nvmrc)).

## Contributing

Contributions are welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md), which lists the rules
pull requests are checked against, then [`CLAUDE.md`](./CLAUDE.md) for the hard constraints. Look
for issues labeled `good-first-issue`. By participating you agree to follow the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

Please do not open public issues for vulnerabilities. Report them privately as described in
[`SECURITY.md`](./SECURITY.md).

## License

[Apache-2.0](./LICENSE)
