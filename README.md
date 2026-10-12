# Phargus

> All-seeing runtime diagnostics for Node.js.

Phargus is a runtime diagnostics agent for Node.js. One line loads the agent into your process; it
samples event loop lag, memory, GC and stream backpressure, traces incoming HTTP requests, and
writes everything as NDJSON. An optional collector and a small dashboard, shipped in the same
package, turn that stream into time windows, alerts and a live page in your browser. They are
libraries you run in your own process, not a service: the agent works on its own and has **zero
external dependencies**, with no hosted account and no separate backend to deploy.

> **Status: 0.1.0, the first release, is being published to npm.** Roadmap steps S0 to S7 are
> implemented on `main` (agent, collector, dashboard, tracing, V8 and memory depth, plugin runner,
> OpenTelemetry export; see [`ROADMAP.md`](./ROADMAP.md)). Until the package is available on npm,
> try `@pharn-dev/phargus` from a locally built tarball (below).

## Why Phargus

- [clinic.js](https://clinicjs.org/) is heavy and one-shot: capture, then analyze offline.
- OpenTelemetry is powerful but takes real setup for a quick look.
- Hosted APMs cost money and require an account.

Phargus is meant for a quick look at a live process: one line, in-process, no account. The agent's
zero-dependency rule is never relaxed.

## Requirements

**Node.js 22.18 or newer** (`engines.node` is `>=22.18.0`; [`.nvmrc`](./.nvmrc) pins the tested
floor). On Node 22, request tracing is noticeably more expensive for promise-heavy code than on
Node 24; see [`docs/LIMITS.md`](./docs/LIMITS.md#1-cost-and-overhead).

## Install

Once the first release is published:

```bash
npm install @pharn-dev/phargus
```

## Try it from source

```bash
git clone https://github.com/pharn-dev/phargus.git
cd phargus
npm ci
npm pack                       # builds dist/ and writes pharn-dev-phargus-0.1.0.tgz
cd /path/to/your-app
npm install /path/to/phargus/pharn-dev-phargus-0.1.0.tgz
```

## Usage

Load the agent first, before your own code:

```js
// CommonJS
require('@pharn-dev/phargus/agent');

// ESM
import '@pharn-dev/phargus/agent';
```

Or with no source edit:

```bash
node --require @pharn-dev/phargus/agent app.js     # CommonJS app
node --import @pharn-dev/phargus/agent app.mjs     # ESM app
```

By default the agent writes one sample line per second (about 2 KB) to **your process's stdout**,
plus one line per traced request. Choose the destination with `PHARGUS_OUTPUT`:

| Variable              | Default  | Meaning                                                   |
| --------------------- | -------- | --------------------------------------------------------- |
| `PHARGUS_OUTPUT`      | `stdout` | `stdout`, `none` (agent off), or a file path              |
| `PHARGUS_INTERVAL_MS` | `1000`   | sampling interval                                         |
| `PHARGUS_QUEUE_BOUND` | `1024`   | lines held per output queue before the oldest are dropped |
| `PHARGUS_ENABLED`     | `true`   | `false` or `0` turns the agent off                        |

The same keys (`output`, `intervalMs`, `queueBound`, `enabled`) can go in `phargus.config.json` or
`phargus.config.js` in the working directory. An unknown `PHARGUS_*` variable prints one warning on
stderr and is ignored. An invalid value disables the agent with one `[phargus] agent disabled: ...`
line on stderr; your app keeps running.

### Getting to the dashboard

The agent does not start a server. You wire `@pharn-dev/phargus/collector` and `@pharn-dev/phargus/dashboard` to the agent's
NDJSON, usually in a second process. A minimal version, assuming your app writes nothing else to
stdout:

```js
// collect.mjs — run as: node --import @pharn-dev/phargus/agent app.mjs | node collect.mjs
import { createInterface } from 'node:readline';
import { createCollector } from '@pharn-dev/phargus/collector';
import { createDashboardServer } from '@pharn-dev/phargus/dashboard';

async function* records(input) {
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (line.trim() !== '') yield JSON.parse(line);
  }
}

const collector = createCollector({ windowMs: 1000, capacity: 300 });
const dashboard = await createDashboardServer({ collector, host: '127.0.0.1', port: 7070 });
process.stderr.write(`phargus dashboard on ${dashboard.url}\n`);
await collector.consume(records(process.stdin));
```

[`examples/express-app`](./examples/express-app) is the complete version: it forks the app, reads
its stdout into a collector with an alert rule, serves the dashboard, and shuts both down cleanly.

**Dashboard access.**

- On a loopback address (`127.x.x.x`, `localhost`, `::1`) the token is optional. Binding any other
  address without a `token` is refused at startup.
- With a token, open `http://<host>:<port>/?token=<token>` once in a browser. The server answers
  with a redirect to `/` and an `HttpOnly`, `SameSite=Strict` cookie, so the token does not stay
  in the address bar or history. `?token=` is accepted on `/` only.
- Scripts and `curl` send `Authorization: Bearer <token>`, for example to `/events`.
- The server answers only requests whose `Host` is the bound address on the bound port (plus
  `localhost`, `127.0.0.1` and `[::1]` for a loopback or `0.0.0.0`/`::` bind); anything else gets
  `421`. A cross-origin `Origin` on `/events` gets `403`. Behind a reverse proxy, or when you
  reach the dashboard by another name, list that name in `allowedHosts`.
- The dashboard is plain HTTP. For remote access use an SSH tunnel or a TLS-terminating proxy.

## What you get

- **Runtime samples** (every interval): event loop delay (min, max, mean, p50, p99), memory
  (`heapUsed`, `heapTotal`, `rss`, `external`, `arrayBuffers`), V8 heap space statistics, GC count,
  total and max pause and counts by kind (from `PerformanceObserver`), and stream backpressure: how
  often and how long writes stalled, grouped by the call site that wrote.
- **Backpressure coverage**: `Writable` subclasses, `fs.WriteStream`, `Duplex`, `Transform`,
  `PassThrough`, `net.Socket`, `tls.TLSSocket`, `http.ServerResponse` and `http.ClientRequest`.
- **Request tracing**: each request to a `node:http` or `node:https` server gets a trace id (or
  continues an incoming W3C `traceparent`), carried through its async work by `AsyncLocalStorage`
  with no change to your code. Spans record method, path without the query string, status and
  duration. `currentTraceId()` reads the id anywhere in that request's async work.
- **Loss accounting**: output queues are bounded and drop the oldest lines; every sample line
  carries cumulative `dropped: { samples, spans }` counters.
- **V8 and memory tools** (library API): on-demand heap snapshots (`takeHeapSnapshot`), snapshot
  summaries and diffs and stack-trace symbolization in a Worker Thread pool (`@pharn-dev/phargus/analyzer`),
  allocation sampling (`sampleAllocations`), and a parser for `node --trace-deopt` output
  (`createDeoptParser`). The parser does not capture that output; you feed it the lines.
- **Collector** (`@pharn-dev/phargus/collector`): fixed time windows with integer math, threshold alerts, alert
  sinks (stdout, file, webhook), and opt-in persistence of recent windows to an append-only file.
- **Dashboard** (`@pharn-dev/phargus/dashboard`): vanilla JS, no framework, no bundler, live over Server-Sent
  Events. Shows the latest event loop, memory and GC figures, alerts, and a waterfall of recent
  requests.
- **Custom rules** (`@pharn-dev/phargus/plugin-runner`): user rules run in an `isolated-vm` sandbox in a child
  process, with a memory limit, a timeout and capped results. `isolated-vm` is an optional peer
  dependency.
- **OpenTelemetry export** (`@pharn-dev/phargus/otel`): opt-in OTLP/HTTP JSON export of windows as metrics and
  spans as traces, using Node core `fetch` only.

[`FEATURES.md`](./FEATURES.md) lists the full scope with the status of each item.

## How it fits together

```
your process                          a second process (or the same one)
┌──────────────────────────────┐      ┌──────────────────────────────────────────┐
│ app code                     │      │ collector: windows, alerts, sinks        │
│ agent: samplers,             │NDJSON│ dashboard: SSE to the browser            │
│ HTTP tracing, bounded output │─────▶│ otel, plugin-runner (opt-in)              │
└──────────────────────────────┘      └──────────────────────────────────────────┘
```

The agent never waits for the consumer: if the reader is slow, the agent drops the oldest queued
lines and counts them, so a slow consumer cannot slow your app.

| Module (`src/…`) | Import as                          | Role                                                            |
| ---------------- | ---------------------------------- | --------------------------------------------------------------- |
| `agent`          | `@pharn-dev/phargus/agent`         | Samples and traces inside your process. Node core only.         |
| `collector`      | `@pharn-dev/phargus/collector`     | Aggregates samples into windows and alerts (stream pipeline).   |
| `analyzer`       | `@pharn-dev/phargus/analyzer`      | Heap-snapshot and stack-trace analysis in Worker Threads.       |
| `dashboard`      | `@pharn-dev/phargus/dashboard`     | SSE server and static UI over a collector.                      |
| `plugin-runner`  | `@pharn-dev/phargus/plugin-runner` | Optional sandbox for user-written diagnostic rules.             |
| `otel`           | `@pharn-dev/phargus/otel`          | Opt-in OTLP/HTTP JSON metrics and trace export. Node core only. |

Phargus is one npm package: the six modules are subpath exports, shipped as both ESM and CommonJS.
See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the data flow and module boundaries.

## Safety and limits

- **Overhead is measured, not assumed.** `bench/overhead.mjs` measures agent-on versus agent-off
  on several HTTP workloads, and `bench/soak.mjs` checks for leaks under load; a nightly workflow
  runs both (see [`bench/README.md`](./bench/README.md)). The benchmark is informational: no gate
  fails on an overhead regression. Measure on your own workload.
- **Prototype patches are reversible and never throw.** The backpressure probe wraps `write` on
  the stream prototypes and tracing wraps `Server.prototype.emit`; disabling them never removes a
  wrapper another library installed later.
- **The agent runs under the Node permission model.** The flags each module needs are in
  [`docs/PERMISSIONS.md`](./docs/PERMISSIONS.md).
- **Heap snapshots and traces can contain sensitive data.** See [`SECURITY.md`](./SECURITY.md),
  [`docs/THREAT-MODEL.md`](./docs/THREAT-MODEL.md) and [`docs/LIMITS.md`](./docs/LIMITS.md).

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
