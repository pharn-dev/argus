---
spec_id: express-app-example
spec_content_hash: 470881cda3f5079bb539e8a36521b59e9bf62fe3c0e7827ee00d51a8b23a3235
applied_lessons: none
---

## Approach

> ADVISORY — model work. Derived from the Approved SPEC; it adds no intent the SPEC does not express.

The example is two small ESM files under `examples/express-app/`, following the `examples/worker-pool`
conventions (plain `.mjs`, no `package.json` of its own, Argus reached only through the root package's
`exports` self-reference `argus/<subpath>`, which resolves to `dist`).

**Why two processes.** Discovery this run: the agent's NDJSON destination is `stdout`, `none` or a file path
(`src/agent/agent-output.ts`, `src/agent/config-schema.ts`); there is no in-process hand-off, and with ESM the one-line
`import 'argus/agent'` evaluates before any code could set `ARGUS_OUTPUT`. A file destination would need the example to
tail a file (fragile, and a check-then-use race). So the example mirrors how Argus is meant to run: the monitored app
writes NDJSON to its stdout, and a separate collector process consumes that stream.

- `examples/express-app/app.mjs` — the monitored HTTP app. First line `import 'argus/agent';` (the one-line agent
  setup; the agent writes NDJSON to this process's stdout). A `node:http` server on `127.0.0.1` with three routes:
  - `GET /fast` → 200, small text body;
  - `GET /slow` → busy-waits ~200 ms of CPU on the event loop (a bounded loop over `performance.now()` doing integer
    work), then 200 — well over the 50 ms the SPEC's AC-2 needs, and over the alert threshold;
  - `GET /error` → 500, small text body;
  - anything else → 404.
    The app writes nothing of its own to stdout (stdout is the agent's NDJSON channel). It reports its bound port to
    the parent over the IPC channel (`process.send({ type: 'listening', port })`), and shuts down on an IPC
    `{ type: 'shutdown' }` message, on SIGTERM/SIGINT, or when the IPC channel disconnects (parent gone): it calls
    `server.close()` + `server.closeAllConnections()`, then `process.disconnect()` when still connected, and lets the
    process exit naturally (no `process.exit()`, so the agent's buffered stdout drains). `server` `error`, request
    handler failures and `clientError` are handled explicitly (stderr message; a server error sets exit code 1).
- `examples/express-app/index.mjs` — the entry (what the README and the test run). It does **not** load the agent.
  1. Reads ports from `APP_PORT` and `DASHBOARD_PORT` (defaults `3000` and `7070`; `0` allowed). Validated with a
     fixed-length digit check (`/^[0-9]{1,5}$/`, no nested quantifiers) and a 0–65535 range check; a bad value is a
     stderr message and exit 1. These names deliberately avoid the `ARGUS_` prefix: the agent rejects unknown
     `ARGUS_*` variables (`src/agent/config-env.ts`).
  2. `fork()`s `app.mjs` (path from `fileURLToPath(new URL('./app.mjs', import.meta.url))`, not an import) with
     `stdio: ['ignore', 'pipe', 'pipe', 'ipc']` and an env of `process.env` plus `ARGUS_OUTPUT=stdout`,
     `ARGUS_INTERVAL_MS` defaulting to `250` when unset, and `APP_PORT`.
  3. Creates the collector: `createCollector({ windowMs: 1000, capacity: 120, alerts: [{ id: 'event-loop-lag',
metric: 'eventLoop.max', comparison: '>=', threshold: 50_000_000 }] })` (one alert rule; no extra sinks — alerts
     reach the dashboard over SSE, which the SPEC scope allows).
  4. Starts `collector.consume(decodeNdjson(child.stdout))`, where `decodeNdjson` is an async generator over the
     child's stdout chunks (`for await`, utf8): it splits on `'\n'` with `indexOf` (no regex), skips blank lines,
     `JSON.parse`s each line and yields the object; a malformed line or a line over a fixed bound (1 MiB) throws an
     error naming the problem — never skipped silently. `consume` composes it with `stream/promises` `pipeline()`
     internally; no `.pipe()` anywhere.
  5. Forwards the child's stderr with `pipeline(child.stderr, process.stderr, { end: false })` so the agent's
     `[argus] …` lines (if any) stay visible.
  6. Waits for the child's `listening` message (rejecting on the child's `error` or an `exit` before it), then
     `createDashboardServer({ collector, host: '127.0.0.1', port, onError })` (`onError` writes to stderr).
  7. Prints exactly two fixed-prefix stdout lines (the address-reporting mechanism the README and the test share):
     `[express-app] app listening on http://127.0.0.1:<port>` and
     `[express-app] dashboard listening on http://127.0.0.1:<port>`.
  8. Shutdown on SIGTERM/SIGINT (`process.once`): send the child `{ type: 'shutdown' }` (fall back to
     `child.kill('SIGTERM')` when the channel is gone), await the child's exit, the `consume` promise (it settles
     when the child's stdout ends), and the stderr pipeline; then `dashboard.close()` and `collector.close()`. All
     are awaited together with their errors collected (no swallowed rejection). Exit code 0 only when the child
     exited 0 and every step succeeded; otherwise a `[express-app] failed: …` line on stderr and exit code 1. A
     shutdown timer (10 s, `unref`) kills the child with SIGKILL and exits 1 if shutdown hangs. An unexpected child
     exit while running is a failure: close the dashboard and collector, stderr message, exit 1.
  9. `main().catch(...)` writes `[express-app] failed: <stack>` to stderr and sets `process.exitCode = 1`.

The README documents: build first (`npm run build`), run with `node examples/express-app/index.mjs`, the
`APP_PORT` / `DASHBOARD_PORT` variables, the routes, the two address lines, opening the dashboard, SIGTERM/Ctrl-C
shutdown, and that the same one-line `import 'argus/agent'` (or `require('argus/agent')`) setup works unchanged for
an Express app — the example uses `node:http` only so Argus gains no dependency.

## Applied lessons

- none — `check-lessons-index.mjs --verdict` returned `NO_CANON`: this project has no `memory-bank/lessons-learned.md`
  yet, so there are no promoted lessons to apply.

## Steps

- Write `examples/express-app/app.mjs` as described: one-line agent import, `node:http` server on `127.0.0.1`, the
  three routes plus 404, IPC `listening` report, shutdown on IPC message / SIGTERM / SIGINT / disconnect, explicit
  error handling, nothing written to stdout.
- Write `examples/express-app/index.mjs` as described: port parsing and validation, `fork` of `app.mjs`, collector
  with the `eventLoop.max >= 50_000_000` alert rule, NDJSON decoding async generator into `collector.consume`, stderr
  forwarding via `pipeline(..., { end: false })`, dashboard on `127.0.0.1`, the two `[express-app] … listening on`
  lines, orderly shutdown with exit code 0 / 1, and a top-level catch.
- Write `examples/express-app/README.md` with the build and run commands, configuration, routes, output lines,
  shutdown, and the Express note.
- Run `node node_modules/prettier/bin/prettier.cjs --write` on each of the three files by name, then the gates:
  `npm run build`, `npm run check:exports`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`.
- Smoke-run the example locally against the built `dist` with `APP_PORT=0 DASHBOARD_PORT=0`, request the three
  routes, read `/events`, and send SIGTERM, before handing over.

## Files

- `examples/express-app/app.mjs` — the monitored `node:http` app: one-line `import 'argus/agent'`, `/fast` (200),
  `/slow` (~200 ms CPU block, 200), `/error` (500), 404 otherwise; reports its bound port over IPC; shuts down on IPC
  message, SIGTERM, SIGINT or IPC disconnect; writes nothing to stdout (the agent's NDJSON channel)
- `examples/express-app/index.mjs` — the runnable entry: reads `APP_PORT` / `DASHBOARD_PORT`, forks `app.mjs`, decodes
  its NDJSON stdout into an `argus/collector` collector with an `eventLoop.max` alert rule, serves `argus/dashboard`
  on `127.0.0.1`, prints the two `[express-app] … listening on http://127.0.0.1:<port>` lines, and shuts everything
  down on SIGTERM/SIGINT with exit code 0 (1 on any failure, with a stderr message)
- `examples/express-app/README.md` — run instructions (`npm run build`, then `node examples/express-app/index.mjs`),
  port variables, routes, output lines, shutdown, and the statement that the same one-line agent setup works for an
  Express app

### Explicitly not touched

- `src/**` — no behaviour change to any module (SPEC non-goal); the AC tests under `src/dashboard/` are written by
  `/pharn-test` and are listed only in `AC-TESTS.md`
- `package.json` — `exports` map unchanged, no dependency added, no script added
- `vitest.config.mts`, `tsconfig*.json`, `eslint.config.mjs`, `prettier.config.mjs`, `scripts/**` — test and build
  infrastructure, unchanged
- `examples/express-app/package.json` — deliberately not created: a package scope there would break the
  `argus/<subpath>` self-reference to the root package
- `examples/worker-pool/**`, `ROADMAP.md`, `FEATURES.md`, `CHANGELOG.md`, `README.md` — out of scope

## Acceptance mapping

- AC-1 (three routes answer 200/200/500 and the SSE stream delivers one `span` per request with `name` =
  `<METHOD> <path>` and the matching `statusCode`) → `app.mjs` serves `/fast`, `/slow`, `/error` under the agent,
  whose HTTP tracing records each request's span (`name` is method + space + path without query,
  `src/agent/http-tracing.ts`); the agent flushes spans with each sample (every 250 ms) to stdout; `index.mjs` decodes
  them into the collector, whose span router pushes them to the dashboard's SSE `span` events. Ports 0 and the two
  `listening on` lines let the test reach both servers on `127.0.0.1`.
- AC-2 (a `window` event with `eventLoop.max >= 50_000_000` after a `/slow` request) → `/slow` blocks the app's event
  loop ~200 ms; the agent's event-loop histogram records it in the next sample; the collector's 1000 ms window closes
  when a sample of the following window arrives (≤ ~1.25 s later) and is emitted as an SSE `window` event.
- AC-3 (SIGTERM → exit 0, no `[argus] agent disabled` on stderr; bare `argus/<subpath>` imports only, no `express`,
  README contents) → the shutdown sequence in `index.mjs` step 8 exits 0 after the app, collector pipeline and
  dashboard close; agent stderr is forwarded, so an agent failure would surface; the example files import only
  `node:` builtins and `argus/agent`, `argus/collector`, `argus/dashboard` (the app is started with `fork`, not
  imported); the README contains `npm run build`, `node examples/express-app/index.mjs` and `Express`.

## Risks & open questions

- **Two processes, not one.** The SPEC says the example "loads the agent with a single line, consumes the agent's
  NDJSON output in a collector … and serves the dashboard", and leaves the NDJSON hand-off to the PLAN. This plan
  puts the agent in `app.mjs` and the collector and dashboard in the `index.mjs` parent. The SIGTERM in AC-3 goes to
  the parent, which forwards shutdown to the app. If a reviewer reads the SPEC as requiring one process, the
  alternative is a file destination plus tailing, which this plan rejects as racy.
- **Pre-request windows.** A window closed before `/slow` (for example during startup) could already show
  `eventLoop.max >= 50 ms` on a loaded CI machine. The AC-2 test should only accept a `window` event whose `end` is
  at or after the time the `/slow` request was sent.
- **macOS stdout pipes are asynchronous.** The app never calls `process.exit()`, so pending NDJSON writes drain before
  it exits; the parent's `consume` ends on the child's stdout `end`.
- **The parent dies without shutting down.** The app watches the IPC `disconnect` event and shuts itself down, so it
  is not left orphaned.
- The dist-freshness helper in the AC tests should include `dist/esm/collector/index.js` and
  `dist/esm/dashboard/index.js` alongside `dist/esm/agent/auto.js` (test-stage decision).
