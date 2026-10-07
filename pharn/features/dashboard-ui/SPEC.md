---
spec_id: dashboard-ui
state: Approved
spec_content_hash: 96ec196cd34dd2f95fb482c6294486bf33c7ea3f19eb9aef67c46d2943db4205
approved_by: model
spec_template: pharn-default@sha256:14a54668441fb0319b46bc0e6bcc9fc5ce59bb6cf3adeada609229ca920df42e
spec_kind: quick
---

## Intent

Argus ROADMAP S3 (dashboard), slice 2: the vanilla-JS UI page on top of the token-gated SSE server that
slice 1 (`dashboard-sse-server`) shipped. Today a user can only read the raw `text/event-stream` with curl;
someone diagnosing a live process at 2am needs to open one URL in a browser and see the process's
event-loop lag, memory and GC update live from the collector's windows, plus the recent alerts. The page
must stay tiny (no framework, no bundler, static HTML/CSS/JS shipped in the package), must be protected
exactly as the SSE endpoint is (the same token gating, so a production dashboard is never exposed
unauthenticated), and must be served with a restrictive Content-Security-Policy so the page cannot be
turned into a script-injection or framing vector.

## Scope

**In scope:**

- The existing dashboard server additionally answers `GET /` with a small static HTML page, and serves
  that page's own stylesheet and script as static same-origin assets, all shipped inside the package.
- The page connects to the server's existing SSE endpoint with the same token the page was opened with,
  and renders, live: event-loop lag, memory and GC figures from the newest collector window, and a list
  of recent alerts.
- The page and every asset get the same token gating as the SSE endpoint: when a token is configured, a
  request without the valid token gets HTTP 401 and none of the page or asset content.
- The page and every asset are served with a restrictive `Content-Security-Policy` response header.
- Vitest tests against a real local dashboard server.

**Out of scope (non-goals):**

- Backpressure, trace, trace-waterfall or time-range-scrubbing views (FEATURES.md lists them; later
  slices).
- Charts or history graphs beyond the newest window's figures and the recent-alert list.
- Any change to how the SSE endpoint gates, formats, replays or streams events, beyond what serving the
  page needs.
- Any frontend framework, bundler, build step for the UI, CDN asset or third-party runtime dependency.
- TLS/HTTPS, login forms, sessions with expiry, token rotation, or multiple tokens.
- Any change to `src/agent` or `src/collector`.

## Acceptance Criteria

- **AC-1** Given a dashboard server created from the dashboard entrypoint on `127.0.0.1` with port 0 and
  token `s3cret`, over a collector created from the collector entrypoint When an HTTP client requests
  `GET /?token=s3cret`, then requests every script and stylesheet URL the returned HTML references,
  resolved against the page URL, the way a browser would (carrying any cookie the page response set and
  no `Authorization` header) Then the page response has status 200, a `content-type` starting
  `text/html`, and an HTML body that references at least one same-origin script and at least one
  same-origin stylesheet and contains no inline script content and no inline event-handler attribute;
  every referenced asset response has status 200 with a `content-type` starting `text/javascript` (or
  `application/javascript`) for scripts and `text/css` for stylesheets; and the page response and every
  asset response carry a `content-security-policy` header whose directives include `default-src 'none'`,
  `script-src 'self'`, `style-src 'self'`, `connect-src 'self'`, `base-uri 'none'`, `form-action 'none'`
  and `frame-ancestors 'none'`, and which contains neither `'unsafe-inline'` nor `'unsafe-eval'`
  - verify: integration
- **AC-2** Given a dashboard server created from the dashboard entrypoint on `127.0.0.1` with port 0 and
  token `s3cret`, and the list of asset paths the authorized page (`GET /?token=s3cret`) references When
  `GET /` and `GET` of each asset path are requested with no credentials, with `Authorization: Bearer
  wrong`, and with `?token=wrong` Then every one of those responses has status 401 and a body that
  contains no `<html`, `<script` or `<link` text and none of the authorized asset bodies; and When the
  same paths are requested with `Authorization: Bearer s3cret` Then every response has status 200
  - verify: integration
- **AC-3** Given a dashboard server on `127.0.0.1` with port 0 and token `s3cret` over a collector that has
  already produced a window W1 with event-loop p99 lag of 12 000 000 ns (12 ms), heap used of 52 428 800
  bytes (50 MiB) and a GC count of 7, and a firing alert A1 with rule id `lag-high`, and the page loaded
  from `/?token=s3cret` into a DOM test environment (no real browser) with its own stylesheet and script
  fetched from the server and executed When the script has connected and the collector then produces a
  window W2 with event-loop p99 lag of 34 000 000 ns (34 ms), heap used of 104 857 600 bytes (100 MiB) and
  a GC count of 9 Then, before W2, the section headed `Event loop lag` shows text containing `12` and
  `ms`, the section headed `Memory` shows text containing `50`, the section headed `GC` shows text
  containing `7`, and the section headed `Alerts` lists an item whose text contains `lag-high` and
  `firing`; and after W2 those sections show `34` with `ms`, `100`, and `9` respectively, with the
  `lag-high` alert still listed
  - verify: integration

## Constraints

- `src/dashboard` uses Node core modules only at runtime and imports only from `src/collector` and
  `src/agent`; the root `package.json` keeps no runtime `dependencies`. A dev-only test dependency is
  acceptable.
- The UI is vanilla JS and plain CSS: no framework, no bundler, no build step that transforms the UI
  source, and no request to any origin other than the dashboard server itself.
- The page, its assets and the SSE endpoint keep the same gating rule: token optional on a loopback host,
  required on any other host (the server already refuses to start without one), compared in constant time
  by the existing token check.
- The page and its assets ship inside the published package and are served identically from the ESM and
  CJS builds; `npm run build` and `npm run check:exports` keep passing.
- Every request and response error on the new routes is handled explicitly; no swallowed errors, no
  unhandled rejections, no leaked listeners or timers.
- The `dashboard-sse-server` criteria (SSE replay and live events, 401 gating, backpressure and `close()`)
  still hold.
- Node 22 or later, TypeScript strict mode.

## Assumptions

- The project's `test` script (`vitest run`) is the runner for these criteria, with per-test results
  already configured; the test stage's preflight decides whether that holds.
- A browser cannot attach an `Authorization` header to `<script>`, `<link>` or `EventSource` requests, so
  the PLAN chooses how a page opened with `?token=<token>` carries the token to its assets and to the SSE
  connection (for example by writing the token into the asset and SSE URLs it serves, or by setting an
  `HttpOnly`, `SameSite=Strict` cookie on the authorized page response); AC-1's "the way a browser would"
  accepts either, and any token the server reflects into the HTML is escaped.
- The page may fetch the SSE stream with `fetch` plus an `Authorization` header, or with `EventSource`;
  the PLAN chooses, and the AC-3 test environment supplies whichever the script uses (Node 22 core or a
  dev-only test dependency).
- On a loopback host with no token configured, the page and assets are served without credentials, as
  the SSE endpoint already is.
- Event-loop lag is displayed in milliseconds and memory in MiB or MB (the PLAN picks one, consistently);
  the page may show more figures (p99 and max lag, heap and RSS, GC count and pauses) than AC-3 checks.
- The alert list shows the most recent alerts newest first, bounded to a small number chosen by the
  PLAN, each with at least its rule id and its state.
- Non-`GET` requests to the page or asset paths get 405 once authorized (401 when not), and any other
  unknown path still gets 404 once authorized, as the SSE server already does.
- The page's assets live under fixed, same-origin paths chosen by the PLAN (for example `/app.js` and
  `/app.css`); how they are shipped in the package (copied by the build, or embedded as module strings)
  is the PLAN's choice.
- The CSP directives listed in AC-1 are the minimum; the PLAN may add stricter directives or other
  hardening headers.
