---
spec_id: express-app-example
state: Approved
spec_content_hash: 470881cda3f5079bb539e8a36521b59e9bf62fe3c0e7827ee00d51a8b23a3235
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S3 ("`examples/express-app` wired end to end"). The agent, collector and dashboard each
work on their own, but a user evaluating Argus has no runnable proof that they work together around a
real HTTP app: one line loads the agent, the agent's NDJSON output feeds a collector with an alert rule,
and the dashboard shows the app's requests and vitals live. This increment adds a small runnable HTTP
example app with full Argus instrumentation, a README with run instructions, and an integration test that
runs the example against the built `dist` and watches the dashboard's SSE stream.

## Scope

**In scope:**

- A runnable example under `examples/express-app/` that loads the agent with a single line, consumes the
  agent's NDJSON output in a collector configured with at least one alert rule, and serves the dashboard
  on `127.0.0.1`.
- The example's own HTTP server, built on `node:http`, with at least three routes: a fast one answering
  200, a slow CPU-bound one that blocks the event loop long enough to cause measurable event-loop lag,
  and one answering 500.
- The app's and the dashboard's listening ports are configurable, including port 0, and the example
  reports the actual addresses it bound to so a caller can reach both.
- A clean shutdown on SIGTERM: the HTTP server, the dashboard and the collector pipeline are closed and
  the process exits with code 0.
- The example imports Argus only through the package's own `exports` subpaths (`argus/agent`,
  `argus/collector`, `argus/dashboard`), which resolve to the built `dist`, never to `src`.
- A README in `examples/express-app/` with run instructions (build first, then the run command), the
  routes, and a statement that the same one-line agent setup works for an Express app.
- An integration test under `src/` that uses the built `dist`, runs the example as a child process bound
  to `127.0.0.1` with port 0, sends requests to it, reads the dashboard's SSE stream, and shuts the
  example down.

**Out of scope (non-goals):**

- The Express package itself: Argus and the example gain no dependency of any kind.
- Any change to the behaviour of `src/` modules, to the package's `exports` map, or to the dashboard UI.
- Exposing the dashboard beyond `127.0.0.1`, token configuration, OTel export, disk persistence, the
  plugin runner, or alert sinks beyond what the collector already provides.
- Publishing the example as its own npm package.

## Acceptance Criteria

- **AC-1** Given the package has been built into `dist` and the integration test has started the
  `examples/express-app` entry as a child process with Node, with the app and the dashboard bound to
  `127.0.0.1` on port 0, and has connected to the dashboard's SSE endpoint When the test sends one
  request each to the fast route, the slow route and the error route Then the fast and slow routes
  answer HTTP 200, the error route answers HTTP 500, and within a bounded timeout the SSE stream delivers
  one `span` event per request whose data parses to a span with `name` equal to the request method, one
  space and the route path, and `statusCode` equal to that response's status
  - verify: integration
- **AC-2** Given the same built package, running example and SSE connection as in AC-1 When the test
  sends a request to the slow route Then within a bounded timeout the SSE stream delivers a `window`
  event whose data parses to an aggregated window with an `eventLoop.max` of at least 50 000 000 (50 ms in
  nanoseconds)
  - verify: integration
- **AC-3** Given the example running as in AC-1 When the test sends it SIGTERM Then the child process
  exits with code 0 within a bounded timeout and its stderr contains no `[argus] agent disabled` line;
  and given the files under `examples/express-app/`, every import of Argus in the example's source files
  uses a bare `argus/<subpath>` specifier (none points into `src/` or `dist/` by path), no file imports
  `express`, and a README there contains `npm run build`, the command that runs the example, and the word
  `Express`
  - verify: integration

## Constraints

- The example and its test use Node core modules and the `argus` package only: no new dependencies (no
  `express`), and the root `package.json` keeps no runtime `dependencies`.
- The agent is loaded with one line (`import 'argus/agent'` or `require('argus/agent')`).
- The dashboard binds to `127.0.0.1` only.
- Stream composition uses `stream/promises` `pipeline()`, never `.pipe()`; every stream, server, child
  process and promise has explicit error handling, with no silent failures or swallowed rejections; a
  failure makes the example exit non-zero with a message on stderr.
- The example follows `examples/worker-pool` conventions: plain ESM `.mjs`, no `package.json` of its own.
- Node 22 or later; the existing `npm run build`, `check:exports`, `typecheck`, `lint`, `format:check` and
  `test` gates keep passing, and every new file is Prettier-formatted.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these criteria, with per-test results; it
  collects only `src/**`, so the integration test lives under `src/` (as the worker-pool example's tests
  live under `src/analyzer/`). The test stage's preflight decides whether that holds.
- The package self-reference (`argus/<subpath>` resolved through the root `package.json` `exports`) is
  how the example reaches `dist`, as in `examples/worker-pool`.
- How the example receives its ports (environment variables or arguments) and how it reports its bound
  addresses (for example fixed-prefix stdout lines) are PLAN decisions; the README and the test use the
  same mechanism.
- How the agent's NDJSON output reaches the in-process collector (an output file, a stream, or a pipe
  handed to the collector) is a PLAN decision, as long as the agent is loaded with one line and stays
  enabled.
- A dashboard bound to `127.0.0.1` needs no token, per the locked decision that a token is required only
  when not bound to localhost; if the dashboard requires one anyway, the example prints or accepts it and
  the test uses it.
- The route paths, response bodies, the slow route's CPU work and duration, the alert rule's metric and
  threshold, and the collector's window length are PLAN decisions; the slow route blocks long enough that
  a closed window records at least 50 ms of event-loop lag, and the window length is short enough for the
  test's bounded timeout.
- The span `name` uses the request path without a query string, as the span-export wiring defines it.
- The integration test may build `dist` itself when missing or rely on a build done earlier in the same
  run, as the worker-pool example's tests do.
