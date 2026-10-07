---
spec_id: dashboard-ui
spec_content_hash: 96ec196cd34dd2f95fb482c6294486bf33c7ea3f19eb9aef67c46d2943db4205
applied_lessons: none
---

## Approach

> ADVISORY: model work. This plan comes from the Approved SPEC `dashboard-ui` (ROADMAP S3, slice 2).

Discovery (live, this run): `src/dashboard/server.ts` `createDashboardServer(options)` builds one `node:http` server
whose request handler parses `new URL(req.url ?? '/', 'http://localhost')`, then, when a token is configured, runs
`presentedToken(req, url)` + `tokensMatch` (`src/dashboard/auth.ts`: Bearer header first, else `?token=`) and answers
`401` (`text/plain`, body `unauthorized\n`, `www-authenticate: Bearer`) **before any routing**; then routes `/events`
(`GET` → SSE replay + live, other method → `405`) and answers `404` for every other path. The `plain()` helper writes
text responses. `tsconfig.base.json` is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`),
`lib: ["ES2022"]` (no DOM types). `scripts/build.mjs` compiles `src/**/*.ts` with `tsc` twice (`tsconfig.esm.json`
→ `dist/esm`, `tsconfig.cjs.json` with `module: CommonJS` → `dist/cjs`) and copies nothing else. vitest runs
`src/**/*.test.ts` with `environment: 'node'`; no DOM library is installed (`node_modules` has none; the npm registry
answered `happy-dom` 20.14.5 this run). `AggregatedWindow` (`src/collector/window.ts`) carries integer ns lag
(`eventLoop.{max,p99,mean}`), bytes (`memory.{heapUsedLast,heapUsedMax,rssLast,rssMax}`) and
`gc.{count,totalPause,maxPause}`; `Alert` carries `ruleId`, `metric`, `comparison`, `threshold`, `observed`,
`windowStart`, `windowEnd`, `state: 'firing' | 'resolved'`.

### Decisions

1. **How the assets ship: embedded as string modules, not copied files.** Each UI source (HTML template, CSS, client
   JS) is plain text exported from its own TypeScript module under `src/dashboard/ui/`. `tsc` compiles those modules
   into both `dist/esm/dashboard/ui/` and `dist/cjs/dashboard/ui/`, so the page and its assets ship inside the package
   and are byte-identical from the ESM and CJS builds with no change to `scripts/build.mjs`. Copied files were
   rejected: locating them at runtime needs `import.meta.url` in ESM, which `tsc` refuses to compile under the CJS
   build's `module: CommonJS`. The UI text is served verbatim; nothing transforms it (SPEC Constraint: no build step
   that transforms the UI source). The CSS and JS strings are `String.raw` template literals, so backslashes stay
   verbatim. The client JS and the CSS must therefore contain **no backtick and no `${`**: the client code uses string
   concatenation only.
2. **How the token reaches the assets and the SSE stream: written into their URLs.** No cookie is used. On an
   authorized `GET /` the server renders the page with `?token=<configured token>` appended to the stylesheet `href`,
   the script `src` and the SSE URL. The token is `encodeURIComponent`-encoded, then HTML-attribute-escaped
   (`& < > " '`). The SSE URL goes in `<meta name="argus-events" content="events?token=…">`. With no token
   configured, the URLs carry no query. This keeps the SSE endpoint's gating byte-for-byte unchanged (it already
   accepts `?token=`). It also works the way a browser loads `<script>`, `<link>` and `fetch` (AC-1). The rendered
   HTML reflects the **configured** token, never the presented string: they are equal after `tokensMatch`. It is
   rendered once at server creation, because the token is fixed for the server's life.
3. **How the page reads the stream: `fetch` plus a streamed body reader, not `EventSource`.** Node 22 has no global
   `EventSource` without a flag, and a DOM test library may not supply one. A `fetch` stream works in every current
   browser and under `connect-src 'self'`. A test environment can also back it with Node 22's own `fetch`. The script
   uses only the standard globals `fetch`, `TextDecoder`, `URL`, `document`, `setTimeout`, `clearTimeout`, `JSON` and
   `console`, looked up at call time.
4. **Paths:** the page is `/`; the assets are `/app.css` and `/app.js`. All three are referenced **relatively**
   (`app.css?…`, `app.js?…`, `events?…`), so a reverse proxy that mounts the dashboard under a sub-path keeps working.
   They resolve to `/app.css`, `/app.js` and `/events` against the page URL `/`.
5. **Headers on the page and both assets:**
   - `content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
     base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. It has no `'unsafe-inline'` and no
     `'unsafe-eval'`.
   - `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY`,
     `cross-origin-opener-policy: same-origin`, `cross-origin-resource-policy: same-origin`.
   - `cache-control: no-store`: the HTML and the asset URLs carry the token.
   - `content-length`.
6. **Content types:** `text/html; charset=utf-8`, `text/css; charset=utf-8`, `text/javascript; charset=utf-8`.
7. **Units (SPEC Assumption):** lag in milliseconds, one decimal (`(ns / 1e6).toFixed(1) + ' ms'`). Memory in MiB, one
   decimal (`(bytes / 1048576).toFixed(1) + ' MiB'`). GC count as a plain integer; GC pauses in ms. This is
   display-only float formatting. No counter or aggregate is computed in floating point.
8. **Alert list:** newest first, capped at **20** items. Each item's text is
   `<ruleId> <state> — <metric> <comparison> <threshold> (observed <observed>)` plus the window end time. Every item
   is built with `document.createElement` + `textContent`, never `innerHTML`, so a rule id can never inject markup.
   The list is cleared when a new SSE connection opens, because the server replays its alert snapshot on every
   connection; this avoids duplicates after a reconnect.

### Modules (one axis of change each; Node core only; nothing outside `src/dashboard` changes except the dev dependency)

1. **`src/dashboard/security-headers.ts` (new)** — the response hardening policy, nothing else.
   - `export const CONTENT_SECURITY_POLICY: string` — the directive string in Decision 5.
   - `export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>>` — the CSP plus the other headers in
     Decision 5, `cache-control` included.
2. **`src/dashboard/ui/page.ts` (new)** — the page markup.
   - `export function renderPage(tokenQuery: string): string`. `tokenQuery` is `''` or `'?token=' +
     encodeURIComponent(token)`. The function HTML-attribute-escapes it (a local `escapeAttribute` that replaces
     `&`, `<`, `>`, `"`, `'`) and returns the document.
   - The document starts with `<!doctype html>`, `<html lang="en">`, `<meta charset="utf-8">`, a viewport meta,
     `<meta name="referrer" content="no-referrer">`, `<meta name="argus-events" content="events{q}">`,
     `<title>Argus</title>`, `<link rel="stylesheet" href="app.css{q}">` and
     `<script src="app.js{q}" defer></script>`, the only script element, which has no inline content.
   - The body has a `<header>` with `<h1>Argus</h1>` and `<p id="status">connecting</p>`, and a `<main>` with four
     `<section>`s, each led by an `<h2>`:
     - `<h2>Event loop lag</h2>` + `<p id="lag">`.
     - `<h2>Memory</h2>` + `<p id="memory">`.
     - `<h2>GC</h2>` + `<p id="gc">`.
     - `<h2>Alerts</h2>` + `<ul id="alerts">` + `<p id="alerts-empty">No alerts yet</p>`.

     The figure placeholders hold a dash (`–`), no digit.
   - The markup has no `style=` attribute and no `on*=` attribute.
3. **`src/dashboard/ui/app-style.ts` (new)** — `export const APP_STYLE: string` (`String.raw`). It holds a small
   plain-CSS stylesheet: system font stack, a responsive grid of the four sections, large numerals for the figures,
   and a status colour per state through classes (`.status-live`, `.status-reconnecting`, `.status-error`) plus a
   `prefers-color-scheme: dark` variant. It has no `@import` and no `url(…)`, so it makes no external or extra
   request.
4. **`src/dashboard/ui/app-script.ts` (new)** — `export const APP_SCRIPT: string` (`String.raw`). The client is
   **one classic script** (no `import`/`export`, so it can run as a plain `<script defer>` and also when a test
   evaluates its text in a DOM window), wrapped in an IIFE with `'use strict'`. It starts with `init()` immediately
   when `document.readyState !== 'loading'`, else on `DOMContentLoaded`.
   - `init()` reads `<meta name="argus-events">` and resolves it with `new URL(content, document.baseURI)`. It looks
     up `#status`, `#lag`, `#memory`, `#gc`, `#alerts`, `#alerts-empty`; a missing element sets the status text to an
     error and stops, with `console.error`.
   - `connect()` sets the status to `connecting` and calls `fetch(eventsUrl, { headers: { accept:
     'text/event-stream' }, cache: 'no-store', credentials: 'same-origin' })`.
     - Status `401`/`403`: set the status to `unauthorized — open the dashboard with ?token=…` and **stop**; no retry
       loop against a refusing server.
     - Any other non-2xx: set an `HTTP <status>` error and schedule a retry.
     - On `ok`: reset the backoff, clear the alert list, set the status to `live`, then read
       `response.body.getReader()` in a loop with one `TextDecoder` in `stream: true` mode.
   - SSE parsing (pure functions inside the IIFE):
     - Normalize `\r\n` to `\n`, append to a buffer, and split complete frames on `\n\n`.
     - In each frame, ignore `:` comment lines (the heartbeat). Take `event:` and concatenate the `data:` lines; one
       leading space after the colon is stripped.
     - `event: window` → `renderWindow(JSON.parse(data))`; `event: alert` → `addAlert(JSON.parse(data))`; unknown
       events are ignored.
     - A `JSON.parse` failure is caught, logged with `console.error` and shown in the status. The stream keeps going,
       so nothing fails silently.
   - `renderWindow(w)` sets three `textContent`s:
     - `#lag`: `p99 <ms> · max <ms>`.
     - `#memory`: `heap <MiB> · rss <MiB>`, from `heapUsedLast` and `rssLast`.
     - `#gc`: `<count> collections · <totalPause ms> total pause · <maxPause ms> max`.

     The last window received is the newest: the replay is oldest-first, then live.
   - `addAlert(a)` prepends an `<li>` (text per Decision 8), trims the list to 20, and hides `#alerts-empty` through
     its `hidden` property.
   - Reconnect: a stream `done`, a read error or a `fetch` rejection sets the status to `reconnecting` and schedules
     `connect()` with `setTimeout`. The backoff starts at 1000 ms and doubles to a 30000 ms cap. Only one timer is
     pending at a time: the previous id is cleared first. Every promise chain ends in a `.catch` that routes to the
     same handler, so there is no unhandled rejection.
5. **`src/dashboard/static-assets.ts` (new)** — the static route table.
   - `export type StaticAsset = { readonly contentType: string; readonly body: Buffer }`.
   - `export function createStaticAssets(token: string | undefined): ReadonlyMap<string, StaticAsset>` returns
     `'/'` (`renderPage(tokenQuery)`, HTML), `'/app.css'` (`APP_STYLE`, CSS) and `'/app.js'` (`APP_SCRIPT`, JS).
     Each body is a `Buffer` created once.
6. **`src/dashboard/server.ts` (modified, small)**
   - After option validation, `const assets = createStaticAssets(token)`.
   - In the request handler, **after the unchanged auth check and `/events` branch** and before the `404`:
     `const asset = assets.get(url.pathname)`. When it is defined, `GET` → `serveAsset(req, res, asset)`; any other
     method → `plain(res, 405, 'method not allowed\n', { allow: 'GET' })`.
   - `serveAsset` attaches `req`/`res` `'error'` listeners that report through the existing `report` (an ordinary
     `ECONNRESET`/`aborted` disconnect is not reported, the same rule the SSE `fail` uses), then
     `res.writeHead(200, { ...STATIC_SECURITY_HEADERS, 'content-type': asset.contentType, 'content-length':
     String(asset.body.byteLength) })` and `res.end(asset.body)`. The listeners are `once` and are removed on the
     response's `'close'`. No timer is involved.
   - The disconnect test becomes a small `isDisconnect(error)` helper shared by `fail` and `serveAsset`; its behaviour
     is unchanged.
   - Nothing else changes: the 401 path still precedes all routing (so the page and assets get exactly the SSE
     endpoint's gating rule, and an unauthorized response body stays `unauthorized\n`), and `/events`, heartbeat,
     backpressure and `close()` are untouched.
7. **`package.json` (modified)** — adds `happy-dom` (`^20.14.5`; the 20.x line, not an older major with known VM-escape
   advisories) to `devDependencies` only. `dependencies` stays absent. `scripts`, `exports`, `files`, `engines` and
   every other field are unchanged.
8. **`package-lock.json` (modified)** — regenerated by `npm install` for the new dev dependency, and committed per
   CLAUDE.md.

The page script runs only in the viewer's browser. The server side stays `node:` built-ins only: `node:http`, plus
the `Buffer` global.

## Applied lessons

- none: the project has no memory-bank yet (`check-lessons-index.mjs --verdict` printed `NO_CANON`), so there are no
  lessons to apply.

## Steps

- Add `src/dashboard/security-headers.ts`.
- Add `src/dashboard/ui/page.ts`, `src/dashboard/ui/app-style.ts` and `src/dashboard/ui/app-script.ts`. The CSS and JS
  go inside `String.raw` templates with no backtick or `${`.
- Add `src/dashboard/static-assets.ts`.
- Wire the static routes into `src/dashboard/server.ts` after `/events`, with the 405 handling and the shared
  `isDisconnect` helper.
- Add the dev dependency: run `npm install --save-dev happy-dom@^20.14.5`, which writes `package.json`,
  `package-lock.json` and the git-ignored `node_modules/`.
- Run `npx prettier --write` on each written source file by name.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run check:exports` and
  `npm run format:check`.
- Confirm that `dist/esm/dashboard/ui/*.js` and `dist/cjs/dashboard/ui/*.js` both exist.
- Manually open `GET /?token=…` from a built server and check that the page renders.

## Files

- `src/dashboard/security-headers.ts` — new. `CONTENT_SECURITY_POLICY` and `STATIC_SECURITY_HEADERS` (CSP,
  `nosniff`, `no-referrer`, `DENY`, COOP, CORP, `no-store`).
- `src/dashboard/ui/page.ts` — new. `renderPage(tokenQuery)`: the escaped HTML document with the four headed sections,
  the relative asset and SSE URLs, no inline script, style or event handler.
- `src/dashboard/ui/app-style.ts` — new. `APP_STYLE`: the plain-CSS stylesheet as a `String.raw` string.
- `src/dashboard/ui/app-script.ts` — new. `APP_SCRIPT`: the classic-script vanilla-JS client as a `String.raw` string
  (fetch-stream SSE parser, window and alert rendering, reconnect with backoff).
- `src/dashboard/static-assets.ts` — new. `StaticAsset` and `createStaticAssets(token)`: the `/`, `/app.css` and
  `/app.js` route table with `Buffer` bodies.
- `src/dashboard/server.ts` — modified. Serves the static routes after the unchanged auth check and `/events` branch,
  with 405 for non-GET, explicit error listeners, and a shared `isDisconnect` helper.
- `package.json` — modified. Adds the `happy-dom` dev dependency only, for the AC-3 DOM test environment.
- `package-lock.json` — modified. Regenerated by `npm install` for that dev dependency.

### Explicitly not touched

- `src/agent/**` and `src/collector/**` — out of scope per the SPEC.
- `src/dashboard/auth.ts`, `src/dashboard/sse-client.ts`, `src/dashboard/sse-format.ts` — reused as is; the SSE gating,
  format, replay and streaming do not change.
- `src/dashboard/index.ts` — the public entrypoint already exports `createDashboardServer`; nothing new is exported.
- `src/dashboard/index.test.ts` and `src/dashboard/dashboard-sse-server.ac*.integration.test.ts` — existing tests; they
  must keep passing unchanged.
- `vitest.config.mts`, `tsconfig.base.json`, `tsconfig.esm.json`, `tsconfig.cjs.json`, `tsconfig.json`,
  `eslint.config.mjs`, `scripts/build.mjs`, `scripts/check-exports.mjs` — test and build infrastructure. The embedded
  assets need no build change, and the AC-3 test loads its DOM library inside the test body, so the vitest
  environment stays `node`.

## Acceptance mapping

- **AC-1** (server on `127.0.0.1:0`, token `s3cret`; `GET /?token=s3cret`, then each referenced script and stylesheet
  URL resolved against the page URL with no `Authorization` header).
  - The auth check passes on `?token=`, and `/` serves `renderPage('?token=s3cret')` as `text/html` with status 200.
  - The HTML references `app.css?token=s3cret` (one same-origin stylesheet) and `app.js?token=s3cret` (one same-origin
    script with no inline content). It has no inline script and no `on*=` attribute.
  - The asset URLs carry the token, so each is authorized the same way. They return 200 as `text/javascript` and
    `text/css`.
  - Every one of these responses carries `STATIC_SECURITY_HEADERS`, whose CSP has the seven required directives and
    neither `'unsafe-inline'` nor `'unsafe-eval'`.
- **AC-2** (token `s3cret`; `/`, `/app.css`, `/app.js` with no credentials, `Bearer wrong`, `?token=wrong`, then with
  `Bearer s3cret`).
  - The unchanged 401 branch runs before routing and returns `unauthorized\n` as `text/plain`. That body has no
    `<html`, `<script`, `<link` and none of the asset bodies.
  - `Bearer s3cret` passes `presentedToken`/`tokensMatch` and each path returns its asset with 200.
- **AC-3** (a collector holding W1 with p99 12 000 000 ns, heap 52 428 800 B, GC 7, and a firing `lag-high` alert; the
  page plus its CSS and JS loaded into a happy-dom window at the page URL; then W2 with 34 ms, 100 MiB, GC 9).
  - On connect the server replays W1 and A1. `renderWindow` writes `p99 12.0 ms …` under `Event loop lag`, `heap 50.0
    MiB …` under `Memory`, and `7 collections …` under `GC`. `addAlert` lists `lag-high firing — …` under `Alerts`.
  - The live W2 event then rewrites the three figures to `34.0 ms`, `100.0 MiB` and `9`. No event removes the alert
    item, so `lag-high` stays listed.

## Risks & open questions

- **Names are plan choices.** These are the paths `/`, `/app.css`, `/app.js`, the meta name `argus-events`, the
  element ids, the `<h2>` texts and the display units. The AC tests drive the headed sections and the referenced URLs,
  not the ids.
- **The AC-3 DOM library must load inside the test body** (`await import('happy-dom')`). `/pharn-test` runs before
  the build installs it, so a top-level import or a `@vitest-environment happy-dom` pragma would make the file fail to
  load: `ac-test-not-collected`, not a red.
- **Running the script in happy-dom: test-stage choices.** Turn off happy-dom's own resource loading and evaluate the
  fetched `app.js` text in the window, or let it load the referenced URLs. If happy-dom's `fetch` does not stream a
  response body incrementally, the test can set the window's `fetch` to Node's global `fetch`. The script looks
  `fetch` up at call time, so that override takes effect.
- **Teardown.** The client reconnects on stream end. A test must close the happy-dom window, which cancels its timers
  and fetches, **before** `server.close()`, or a pending reconnect timer outlives the test.
- **`npm install` in the build.** Adding the dev dependency writes `package.json`, `package-lock.json` and
  `node_modules/` through npm, not the Write tool. Both tracked files are in `## Files`, so the generator writes only
  declared paths plus the git-ignored `node_modules/`. It needs registry access (reachable this run).
  `check-ac-tests.mjs` prints an advisory NOTE for `package.json`; the `test` script is not changed.
- **The token is in the URL.** This is the existing SSE mechanism, now also on the page and asset URLs. `no-referrer`,
  `no-store` and same-origin-only requests limit where it travels. It still appears in the browser's history and
  address bar, as `/?token=` already did. A cookie alternative was rejected because it would change the SSE endpoint's
  gating (a SPEC non-goal).
- **Embedded assets.** The UI text lives in TS string modules, so ESLint and Prettier do not check the inner JS and CSS
  as code. The no-backtick / no-`${` rule for `String.raw` is a manual discipline; a slip is a compile error or a
  served script error that AC-3 would catch.
