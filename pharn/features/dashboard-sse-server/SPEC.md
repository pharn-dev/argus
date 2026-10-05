---
spec_id: dashboard-sse-server
state: Approved
spec_content_hash: dca6f9b42960a3e356d7c7a46890b97f0731c85ec4fcf2d8dbfd5e589c9e40b0
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S3 (dashboard), slice 1: the Server-Sent Events server that replaces the `src/dashboard`
scaffold placeholder. The collector already aggregates agent samples into windows and evaluates alerts,
keeping both in ring buffers, but nothing exposes them to a viewer. A user diagnosing a live process needs a
single in-process HTTP endpoint that first shows the recent windows and alerts and then streams each new one
as it happens, built on Node core only. Because the dashboard may be reachable outside localhost in
production, it must be token-gated by default (CLAUDE.md decision "dashboard exposure in production:
token-gated by default"), and a slow viewer must never slow the collector or the monitored app. The vanilla-JS
UI page is the next slice.

## Scope

**In scope:**

- A `createDashboardServer`-style entry (exact name chosen by the PLAN) taking a collector, a host, a port
  and an optional token, starting a `node:http` server, and exported from `src/dashboard/index.ts`.
- An SSE endpoint (for example `GET /events`, `content-type: text/event-stream`) that first replays the
  collector's current window and alert ring snapshots, then streams every new window as `event: window` and
  every new alert as `event: alert`, each with one `data:` line of JSON, plus periodic `:` heartbeat
  comments.
- How the server learns of new windows and alerts (a subscription hook on the collector, or polling the
  rings) is the PLAN's choice; any collector change stays minimal and keeps existing collector behaviour.
- Token gating: on a non-loopback host a token is required (the server refuses to start without one); when
  a token is configured every request must present it as `Authorization: Bearer <token>` or `?token=<token>`,
  compared with `crypto.timingSafeEqual`; an unauthorized request gets HTTP 401 and no data. On a loopback
  host the token is optional.
- Per-client backpressure: each SSE client has a bounded outgoing buffer; when its socket does not drain,
  the oldest pending events are dropped and counted, or the client is disconnected; memory never grows
  without bound.
- `close()` ends every open SSE response and closes the server; client disconnects remove that client's
  listeners and timers; errors are handled explicitly, never swallowed.
- Vitest tests against a real local server using `node:http` or `fetch` clients.

**Out of scope (non-goals):**

- The HTML/vanilla-JS UI page and any static-file serving (the next slice).
- TLS/HTTPS, CORS policy, multiple tokens, token rotation, or any authentication scheme beyond one shared
  token.
- SSE `Last-Event-ID` resumption, event ids, or replaying more history than the ring buffers hold.
- Any change to `src/agent`; `src/collector` never imports from `src/dashboard`.
- OTel export or any other output beyond the SSE endpoint.

## Acceptance Criteria

- **AC-1** Given a collector created from the collector entrypoint that has already produced at least one
  window and one alert, and a dashboard server created from the dashboard entrypoint on `127.0.0.1` with
  port 0, no token and a short heartbeat interval When an HTTP client issues `GET /events`, the collector
  then produces one more window and one more alert, and the client keeps reading past one heartbeat interval
  Then the response status is 200 with a `content-type` starting `text/event-stream`, the stream first
  carries an `event: window` and an `event: alert` whose single `data:` line parses as JSON equal to the
  pre-existing window and alert, then carries an `event: window` and an `event: alert` whose `data:` parses
  as JSON equal to the new window and alert, and at least one line starting with `:` appears
  - verify: integration
- **AC-2** Given the dashboard entrypoint When a server is created on a non-loopback host such as `0.0.0.0`
  without a token Then creation fails (throws or rejects) with an error mentioning the token and no port is
  listening; and given a server created on `127.0.0.1` with port 0 and token `s3cret` When `GET /events` is
  requested with no credentials, with `Authorization: Bearer wrong`, with `?token=wrong`, with
  `Authorization: Bearer s3cret`, and with `?token=s3cret` Then the first three responses have status 401
  and a body containing no `event:` line, and the last two have status 200 with a `content-type` starting
  `text/event-stream`
  - verify: integration
- **AC-3** Given a dashboard server created from the dashboard entrypoint on `127.0.0.1` with port 0, no
  token and a small per-client buffer bound, with one SSE client connected that never reads from its
  socket and one SSE client that reads normally When the collector produces many more windows than the
  buffer bound Then the normally reading client receives every new window as an `event: window`, the
  collector's `windows` ring snapshot holds the newest windows, and the stalled client is either reported
  by the server as having dropped a positive integer count of events or has its connection closed by the
  server; and When `close()` is then called Then it resolves, every open SSE response ends, and a new
  connection to the port is refused
  - verify: integration

## Constraints

- `src/dashboard` uses Node core modules only (`node:http`, `node:crypto`, …) and imports only from
  `src/collector` and `src/agent`; neither of those imports from `src/dashboard`.
- Token comparison uses `crypto.timingSafeEqual` (with a length-safe comparison so differing lengths never
  throw and never short-circuit on content).
- A slow or stalled SSE client never blocks or slows the collector's pipeline or the monitored app's event
  loop; each client's pending output is bounded.
- Every socket, response and server error is handled explicitly; no swallowed errors and no unhandled
  rejections; no leaked listeners or timers after a client disconnects or after `close()`.
- Dropped-event counters are integers.
- A collector used without a dashboard keeps its existing behaviour (the collector-windows, collector-alerts
  and collector-alert-sinks criteria still hold).
- Node 22 or later, TypeScript strict mode, and the package's existing dual ESM/CJS build and exports check
  must keep passing.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these criteria, with per-test results
  already configured; the test stage's preflight decides whether that holds.
- "Loopback" means `127.0.0.1` (and the rest of `127.0.0.0/8`), `::1` and `localhost`; any other host,
  including `0.0.0.0` and `::`, is non-loopback and requires a token.
- Creating the server is asynchronous (it resolves once listening and exposes the bound port, so tests can
  use port 0); refusing to start without a token happens before any port is bound.
- A test may make the collector produce windows and alerts by feeding it a readable source of agent
  samples through its existing `consume(source)`, or through any minimal hook the PLAN adds; the exact
  mechanism is the PLAN's choice.
- The replay sends the window snapshot then the alert snapshot, each oldest first; live events are sent in
  the order the collector produces them.
- The heartbeat interval and per-client buffer bound are configurable options with small finite defaults
  chosen by the PLAN, so tests can set them short.
- "The server reports dropped events" means an integer count exposed on the server object (for example
  per-client or in total); whether the stalled client is dropped-from or disconnected is the PLAN's choice,
  and either satisfies AC-3.
- Requests to paths other than the SSE endpoint get 404 once authorized (and 401 when not); an unauthorized
  request is rejected before any path routing reveals data.
- The scaffold placeholder type and its scaffold test may be replaced or kept as the PLAN decides, as long
  as the scaffold build and exports checks still pass.
