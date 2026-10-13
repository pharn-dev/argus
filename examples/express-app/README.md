# express-app example

Phargus watching a small HTTP app, end to end: one `import '@pharn-dev/phargus/agent'` line in the app, a collector
that aggregates the agent's NDJSON into time windows and alerts, and the live dashboard.

The app uses `node:http` so the example adds no dependency. The agent works the same way in an
Express app: put `import '@pharn-dev/phargus/agent'` (or `require('@pharn-dev/phargus/agent')`) first in the file that starts
your Express server and nothing else changes.

## Run it

From the repo root:

```bash
npm run build
node examples/express-app/index.mjs
```

The example has no `package.json` of its own: `@pharn-dev/phargus/agent`, `@pharn-dev/phargus/collector` and `@pharn-dev/phargus/dashboard`
resolve through the root package's `exports`, so they need the build above.

It starts two processes. `app.mjs` is the monitored app: it loads the agent, which writes NDJSON to
the app's stdout. `index.mjs` reads that stream into an `@pharn-dev/phargus/collector` collector (1 second windows,
an alert when the event loop lag reaches 50 ms) and serves `@pharn-dev/phargus/dashboard`. Both servers bind to
`127.0.0.1` only.

The app logs to its own stdout too (one plain-text line when it starts listening). The parent reads
the stream through `createNdjsonDecoder` and the collector, which skip and count every line that is
not agent data, so the app's own output does not break the collector.

## Configuration

| Variable         | Default | Meaning                                       |
| ---------------- | ------- | --------------------------------------------- |
| `APP_PORT`       | `3000`  | Port of the app. `0` picks a free port.       |
| `DASHBOARD_PORT` | `7070`  | Port of the dashboard. `0` picks a free port. |

`PHARGUS_INTERVAL_MS` is passed to the agent and defaults to `250` here.

## Routes

- `GET /fast` answers 200 at once.
- `GET /slow` blocks the event loop for about 200 ms, then answers 200. This shows up as event loop
  lag in the dashboard and trips the alert.
- `GET /error` answers 500.
- Anything else answers 404.

## What you'll see

```text
[express-app] app listening on http://127.0.0.1:<port>
[express-app] dashboard listening on http://127.0.0.1:<port>
```

Open the dashboard address in a browser, then request the routes, for example
`curl http://127.0.0.1:3000/slow`. Each request appears as a span, and the windows and alerts update live.
The raw stream is at `/events` on the dashboard address (Server-Sent Events).

## Stop it

Press Ctrl-C or send SIGTERM. The example stops the app, drains the collector, closes the dashboard
and exits with code 0. On any failure it prints `[express-app] failed: ...` to stderr and exits with
code 1.
